"""Scan the local copy of the 合辑 (source/): size, mtime and SHA-256 of every file.

Results go to manifest/scan.jsonl, one JSON object per file, sorted by path. Re-running only hashes
files whose size or mtime changed. The source tree is only ever read.

Some names left by broken archive extraction contain U+F000, which WSL maps to NUL, so those files
cannot be opened from Linux. Directories with such files are re-read on the Windows side through
PowerShell, and every path is recorded with its Windows name.
"""

import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from .survey import SurveyFile

READ_SIZE = 4 * 1024 * 1024
# Characters Windows forbids in names; WSL shows U+F000+c on the Windows side as c on the Linux side.
WSL_MAPPED = set('"*:<>?|\\')


@dataclass
class ScanEntry:
    path: str
    size: int
    mtime: str
    sha256: str | None
    note: str | None = None


def windows_name(raw: bytes) -> str:
    """Linux name as shown by WSL -> the name as stored on NTFS."""
    text = raw.decode("utf-8", "surrogateescape")
    return "".join(chr(0xF000 + ord(c)) if ord(c) < 0x20 or c in WSL_MAPPED else c for c in text)


def linux_name(windows_path: str) -> str:
    """Inverse of windows_name: NTFS private-use stand-ins back to what WSL shows."""
    out = []
    for c in windows_path:
        code = ord(c)
        if 0xF000 < code < 0xF080 and (code - 0xF000 < 0x20 or chr(code - 0xF000) in WSL_MAPPED):
            out.append(chr(code - 0xF000))
        else:
            out.append(c)
    return "".join(out)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path: bytes) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(READ_SIZE):
            h.update(chunk)
    return h.hexdigest()


def load_scan(path: Path) -> list[ScanEntry]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as fh:
        return [ScanEntry(**json.loads(line)) for line in fh if line.strip()]


def write_scan(path: Path, entries: list[ScanEntry]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for e in sorted(entries, key=lambda e: e.path):
            fh.write(json.dumps(asdict(e), ensure_ascii=False) + "\n")
    tmp.replace(path)


def as_source_files(entries: list[ScanEntry]) -> list[SurveyFile]:
    return [SurveyFile(e.path, e.size, e.mtime, e.sha256) for e in entries]


def _windows_listing(root: Path, rel_dir: str, want_hash: bool) -> list[ScanEntry]:
    win_root = subprocess.run(["wslpath", "-w", str(root)], capture_output=True, text=True, check=True).stdout.strip()
    win_dir = win_root + "\\" + rel_dir.replace("/", "\\")
    hash_expr = "(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()" if want_hash else "$null"
    script = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
        f"@(Get-ChildItem -LiteralPath '{win_dir.replace(chr(39), chr(39) * 2)}' -File | ForEach-Object {{ "
        "[pscustomobject]@{ name=$_.Name; size=$_.Length; "
        "mtime=$_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ssZ'); "
        f"sha256={hash_expr} }} }}) | ConvertTo-Json -Compress"
    )
    out = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", cwd="/mnt/c", check=True,
    ).stdout.strip()
    items = json.loads(out) if out else []
    if isinstance(items, dict):
        items = [items]
    note = "文件名含无效字符（解压时编码错误），经 Windows 读取"
    return [ScanEntry(f"{rel_dir}/{i['name']}", int(i["size"]), i["mtime"], i["sha256"], note) for i in items]


def scan(root: Path, previous: list[ScanEntry], want_hash: bool = True, workers: int = 4,
         log=lambda msg: print(msg, file=sys.stderr)) -> list[ScanEntry]:
    old = {e.path: e for e in previous}
    entries: dict[str, ScanEntry] = {}
    windows_dirs: set[str] = set()
    to_hash: list[tuple[bytes, ScanEntry]] = []

    root_b = os.fsencode(root)
    for dirpath, _dirs, files in os.walk(root_b):
        rel_dir = windows_name(os.path.relpath(dirpath, root_b)) if dirpath != root_b else ""
        rel_dir = "" if rel_dir == "." else rel_dir
        for raw in files:
            full = os.path.join(dirpath, raw)
            rel = f"{rel_dir}/{windows_name(raw)}" if rel_dir else windows_name(raw)
            try:
                st = os.stat(full)
            except OSError:
                windows_dirs.add(rel_dir)
                continue
            entry = ScanEntry(rel, st.st_size, _iso(st.st_mtime), None)
            prev = old.get(rel)
            if prev and prev.size == entry.size and prev.mtime == entry.mtime and prev.sha256:
                entry.sha256 = prev.sha256
            elif want_hash:
                to_hash.append((full, entry))
            entries[rel] = entry

    for rel_dir in sorted(windows_dirs):
        for e in _windows_listing(root, rel_dir, want_hash):
            entries[e.path] = e  # Windows names win over the partial WSL view of that directory
        log(f"read through Windows: {rel_dir}")

    total = sum(e.size for _, e in to_hash)
    log(f"{len(entries)} files, hashing {len(to_hash)} ({total / 1e9:.1f} GB)")
    done_bytes, done_files, started, last = 0, 0, time.monotonic(), 0.0

    def work(item):
        full, entry = item
        try:
            entry.sha256 = sha256_file(full)
        except OSError as exc:
            entry.note = f"读取失败：{exc.strerror}"
        return entry.size

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for size in pool.map(work, to_hash):
            done_bytes += size
            done_files += 1
            now = time.monotonic()
            if now - last > 15 or done_files == len(to_hash):
                rate = done_bytes / max(now - started, 1e-6) / 1e6
                log(f"hashed {done_files}/{len(to_hash)} files, {done_bytes / 1e9:.1f}/{total / 1e9:.1f} GB, {rate:.0f} MB/s")
                last = now
    return list(entries.values())
