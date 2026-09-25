"""Unpack archives and disc images into extracted/ and hash every member (`uv run ra extract`).

Each archive is unpacked once per content: into ``extracted/<first 16 hex of its SHA-256>/``, with a
record of its members in ``manifest/archives/<sha256>.json``. Archives found inside archives (and
self-extracting EXEs that 7-Zip can open) are unpacked the same way, up to MAX_DEPTH levels. The
source tree is only read; programs are never run.

Legacy zip and LZH archives store names in a local code page (usually Shift-JIS). The code page is
chosen per archive from the raw name bytes, see choose_encoding().

Debian's 7-Zip has no RAR decoder. RAR archives it cannot unpack are handed to Bandizip on the Windows
side when it is installed; either way every unpacked file is checked against the CRC32 in the listing.
"""

import functools
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from .scan import READ_SIZE, ScanEntry, linux_name

MANIFEST_VERSION = 1
MAX_DEPTH = 3
TOP_LEVEL_EXTS = {"zip", "rar", "7z", "lzh", "lha", "iso"}
NESTED_EXTS = {"zip", "rar", "7z", "lzh", "lha"}  # plus .exe when 7-Zip opens it as an archive
ARCHIVE_TYPES = {"zip", "rar", "rar5", "7z", "lzh", "cab", "arj", "iso", "udf", "tar", "gzip", "bzip2", "xz"}
LEGACY_NAME_TYPES = {"zip", "lzh"}  # formats whose names may be in a local code page

# Encodings tried for legacy names, in order of preference when they score the same.
CANDIDATE_ENCODINGS = ("utf-8", "cp932", "gbk", "big5", "cp949")
_SEVEN_ZIP_CP = {"utf-8": "65001", "cp932": "932", "gbk": "936", "big5": "950", "cp949": "949"}


@dataclass
class Member:
    path: str  # inside the archive, '/' separated
    size: int
    mtime: str | None = None
    crc32: str | None = None
    sha256: str | None = None
    note: str | None = None


@dataclass
class ArchiveRecord:
    sha256: str
    size: int
    name: str  # a file name the archive was found under, for messages
    type: str
    encoding: str | None = None
    status: str = "ok"  # ok | encrypted | error
    error: str | None = None
    members: list[Member] = field(default_factory=list)
    version: int = MANIFEST_VERSION
    tool: str = "7z"  # what unpacked it: 7z | bandizip

    @property
    def dir_name(self) -> str:
        return self.sha256[:16]


def load_records(manifest_dir: Path) -> dict[str, ArchiveRecord]:
    records = {}
    if not manifest_dir.is_dir():
        return records
    for path in manifest_dir.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        data["members"] = [Member(**m) for m in data.get("members", [])]
        record = ArchiveRecord(**data)
        records[record.sha256] = record
    return records


def write_record(manifest_dir: Path, record: ArchiveRecord) -> None:
    manifest_dir.mkdir(parents=True, exist_ok=True)
    target = manifest_dir / f"{record.sha256}.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(asdict(record), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(target)


def local_copies(source: Path, entries: list[ScanEntry], records: dict[str, ArchiveRecord],
                 out_root: Path) -> dict[str, Path]:
    """SHA-256 -> a local file with that content: the loose file if there is one, else an unpacked copy."""
    paths: dict[str, Path] = {}
    for record in records.values():
        for m in record.members:
            if m.sha256 and m.sha256 not in paths:
                paths[m.sha256] = out_root / record.dir_name / m.path
    for e in entries:
        if e.sha256:
            paths[e.sha256] = source / linux_name(e.path)
    return paths


# ------------------------------------------------------------------ name encodings


def _char_score(c: str) -> int:
    o = ord(c)
    if o < 0x20 or o == 0x7F or 0xE000 <= o <= 0xF8FF or c == "�":
        return -6  # control, private use, replacement
    if o < 0x80:
        return 0
    if 0x3040 <= o <= 0x30FF:
        return 3  # hiragana, katakana: strong sign of correctly decoded Japanese
    if 0xFF61 <= o <= 0xFF9F:
        return -4  # half-width katakana: typical of GBK or UTF-8 bytes read as Shift-JIS
    if 0x4E00 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7A3 or 0x3000 <= o <= 0x303F or 0xFF01 <= o <= 0xFF5E:
        return 1  # CJK ideographs, hangul, CJK punctuation, full-width ASCII
    if 0xC0 <= o <= 0x24F:
        return 0  # accented Latin letters
    return -2


def choose_encoding(raw_names: list[bytes]) -> str | None:
    """Pick the code page that turns the non-ASCII names into the most plausible text.

    Returns None when every name is plain ASCII (nothing to decide).
    """
    names = [n for n in raw_names if any(b > 0x7F for b in n)]
    if not names:
        return None
    best, best_score = None, None
    for encoding in CANDIDATE_ENCODINGS:
        try:
            text = "".join(n.decode(encoding) for n in names)
        except UnicodeDecodeError:
            continue
        score = sum(_char_score(c) for c in text)
        if best_score is None or score > best_score:
            best, best_score = encoding, score
    return best or "cp932"


def zip_legacy_names(path: Path) -> list[bytes]:
    """Raw bytes of the zip entry names that are not flagged as UTF-8."""
    try:
        with zipfile.ZipFile(path) as zf:
            return [i.orig_filename.encode("cp437") for i in zf.infolist() if not i.flag_bits & 0x800]
    except (zipfile.BadZipFile, OSError, UnicodeEncodeError):
        return []


# ------------------------------------------------------------------ 7-Zip


_ENV = {**os.environ, "LC_ALL": "C.UTF-8"}


def _run_7z(args: list[str]) -> subprocess.CompletedProcess:
    # -p- never prompts for a password; stdin is closed so nothing can hang waiting for input.
    return subprocess.run(["7z", *args], capture_output=True, stdin=subprocess.DEVNULL, env=_ENV)


@functools.cache
def bandizip() -> bool:
    """Whether Bandizip is installed on the Windows side (the Store version has no console tool)."""
    if not shutil.which("powershell.exe"):
        return False
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "(Get-Command bandizip.exe -ErrorAction SilentlyContinue).Source"],
        capture_output=True, text=True, cwd="/mnt/c", stdin=subprocess.DEVNULL,
    )
    return bool(result.stdout.strip())


def _windows_path(path: Path) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def extract_with_bandizip(archive: Path, dest: Path) -> str | None:
    """Unpack with Bandizip's command line; returns an error message or None."""
    # Paths travel as environment variables so no quoting of names with quotes or brackets is needed.
    env = {**os.environ, "RA_SRC": _windows_path(archive), "RA_DST": _windows_path(dest)}
    env["WSLENV"] = ":".join(filter(None, [os.environ.get("WSLENV"), "RA_SRC", "RA_DST"]))
    script = (
        "$p = Start-Process -FilePath 'bandizip.exe' -Wait -PassThru -WindowStyle Minimized "
        "-ArgumentList @('x', '-y', ('-o:\"' + $env:RA_DST + '\"'), ('\"' + $env:RA_SRC + '\"')); exit $p.ExitCode"
    )
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                capture_output=True, cwd="/mnt/c", env=env, stdin=subprocess.DEVNULL, timeout=1800)
    except subprocess.TimeoutExpired:
        return "Bandizip 超时（30 分钟）"
    return None if result.returncode == 0 else f"Bandizip exit {result.returncode}"


@dataclass
class Listing:
    types: list[str]
    items: list[dict[str, bytes]]
    error: str | None


def list_archive(path: Path, codepage: str | None = None) -> Listing:
    args = ["l", "-slt", "-sccUTF-8", "-p-"]
    if codepage:
        args.append(f"-mcp={codepage}")
    result = _run_7z([*args, "--", str(path)])
    head, _, body = result.stdout.partition(b"\n----------\n")
    types = [line[7:].decode().strip().lower() for line in head.splitlines() if line.startswith(b"Type = ")]
    items = []
    for block in body.split(b"\n\n"):
        item = {}
        for line in block.splitlines():
            key, sep, value = line.partition(b" = ")
            if sep:
                item[key.decode("ascii", "replace")] = value
        if "Path" in item:
            items.append(item)
    error = None
    if result.returncode != 0:
        error = _error_text(result)
    return Listing(types, items, error)


def _error_text(result: subprocess.CompletedProcess) -> str:
    text = (result.stderr + b"\n" + result.stdout).decode("utf-8", "replace")
    lines = [ln.strip() for ln in text.splitlines() if re.search(r"ERROR|Error|error|Warning|WARNING", ln)]
    return "; ".join(dict.fromkeys(lines))[:500] or f"7z exit {result.returncode}"


def _mtime(value: bytes | None) -> str | None:
    if not value:
        return None
    text = value.decode("ascii", "replace").strip()
    return text[:19].replace(" ", "T") if len(text) >= 19 else None


def _decode_name(raw: bytes, archive_type: str, encoding: str | None) -> tuple[str, str | None]:
    """Decode a listed name. LZH names are raw bytes; other formats are already UTF-8."""
    if archive_type == "lzh" and encoding:
        try:
            return raw.decode(encoding), None
        except UnicodeDecodeError:
            return raw.decode(encoding, "replace"), "文件名无法按编码完整解读"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return raw.decode("utf-8", "replace"), "文件名无法按编码完整解读"


# ------------------------------------------------------------------ hashing


def hash_file(path: Path) -> tuple[str, str]:
    """SHA-256 and CRC32 (upper-case hex, as 7-Zip prints it) in one read."""
    sha, crc = hashlib.sha256(), 0
    with open(path, "rb") as fh:
        while chunk := fh.read(READ_SIZE):
            sha.update(chunk)
            crc = zlib.crc32(chunk, crc)
    return sha.hexdigest(), f"{crc:08X}"


def is_rk_sfx(path: Path) -> bool:
    """RK self-extractors (an early-2000s archiver) cannot be opened without running them."""
    with open(path, "rb") as fh:
        return b"RK Self Extractor" in fh.read(256 * 1024)


# ------------------------------------------------------------------ extraction


class Extractor:
    def __init__(self, out_root: Path, manifest_dir: Path, log=lambda msg: print(msg, file=sys.stderr)):
        self.out_root = out_root
        self.manifest_dir = manifest_dir
        self.log = log
        self.records = load_records(manifest_dir)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock(self, sha256: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(sha256, threading.Lock())

    def done(self, sha256: str, retry: bool = False) -> bool:
        """Already unpacked by this version of the tool (failed ones count as done unless retrying)."""
        record = self.records.get(sha256)
        if record is None or record.version != MANIFEST_VERSION:
            return False
        return not (retry and record.status == "error")

    def extract(self, path: Path, sha256: str, name: str, depth: int = 0, retry: bool = False) -> ArchiveRecord | None:
        """Unpack one archive (and the archives inside it). Returns None if 7-Zip does not see an archive."""
        with self._lock(sha256):  # the same inner archive can turn up in two archives at once
            if self.done(sha256, retry):
                record = self.records[sha256]
            else:
                record = self._extract_one(path, sha256, name)
                if record is None:
                    return None
                write_record(self.manifest_dir, record)
                self.records[sha256] = record
                self._report(record, name)
        if depth + 1 < MAX_DEPTH and record.status in ("ok", "error"):
            self._nested(record, depth, retry)
        return record

    def _report(self, record: ArchiveRecord, name: str) -> None:
        shown = f"{record.type}, {len(record.members)} files" + (f", {record.encoding}" if record.encoding else "")
        if record.tool != "7z":
            shown += f", {record.tool}"
        self.log(f"{record.status:>11}  {name}  ({shown}){'  ' + record.error if record.error else ''}")

    def _nested(self, record: ArchiveRecord, depth: int, retry: bool) -> None:
        base = self.out_root / record.dir_name
        for m in record.members:
            ext = PurePosixPath(m.path).suffix[1:].lower()
            if not m.sha256 or (ext not in NESTED_EXTS and ext != "exe"):
                continue
            inner = base / m.path
            noted = m.note
            if ext == "exe" and not self._opens_as_archive(inner, m):
                pass
            elif self.extract(inner, m.sha256, PurePosixPath(m.path).name, depth + 1, retry) is None and ext != "exe":
                m.note = m.note or "7-Zip 无法作为压缩包打开"
            if m.note != noted:
                with self._lock(record.sha256):
                    write_record(self.manifest_dir, record)

    def _opens_as_archive(self, path: Path, member: Member) -> bool:
        if self.done(member.sha256):
            return True
        if is_rk_sfx(path):
            if not member.note:
                member.note = "RK 自解压包：7-Zip 无法解开，只保留原件（不运行程序）"
            return False
        listing = list_archive(path)
        return any(t in ARCHIVE_TYPES for t in listing.types)

    def _extract_one(self, path: Path, sha256: str, name: str) -> ArchiveRecord | None:
        size = path.stat().st_size
        listing = list_archive(path)
        archive_type = next((t for t in reversed(listing.types) if t in ARCHIVE_TYPES), None)
        if archive_type is None:
            return None
        if archive_type == "rar5":
            archive_type = "rar"
        if archive_type == "udf":
            archive_type = "iso"

        encoding = None
        if archive_type == "zip":
            encoding = choose_encoding(zip_legacy_names(path))
        elif archive_type == "lzh":
            encoding = choose_encoding([i["Path"] for i in listing.items])
        codepage = _SEVEN_ZIP_CP.get(encoding) if archive_type == "zip" and encoding else None
        if codepage:
            listing = list_archive(path, codepage)

        record = ArchiveRecord(sha256=sha256, size=size, name=name, type=archive_type, encoding=encoding)
        files: list[tuple[Member, bytes]] = []
        encrypted = 0
        for item in listing.items:
            if item.get("Folder") == b"+" or item.get("Attributes", b"").startswith(b"D"):
                continue
            member_path, note = _decode_name(item["Path"], archive_type, encoding)
            crc = item.get("CRC", b"").decode("ascii", "replace").strip().upper() or None
            member = Member(member_path, int(item.get("Size") or 0), _mtime(item.get("Modified")), crc, note=note)
            if item.get("Encrypted") == b"+":
                encrypted += 1
                member.note = "加密，未解开"
            files.append((member, item["Path"]))
        record.members = [m for m, _ in files]

        collisions = _case_collisions([m.path for m in record.members])
        if collisions:
            record.status, record.error = "error", f"包内有仅大小写不同的文件名，无法在 Windows 磁盘上解开：{collisions[0]}"
            return record
        if encrypted and encrypted == len(files):
            record.status = "encrypted"
            return record

        dest = self.out_root / record.dir_name
        if dest.exists():
            shutil.rmtree(dest)  # leftovers of an interrupted run; always inside out_root
        dest.mkdir(parents=True)
        if archive_type == "lzh" and encoding:
            error = self._extract_renaming(path, dest, files, encoding)
        else:
            args = ["x", "-y", "-p-", "-bso0", "-bsp0", f"-o{dest}"]
            if codepage:
                args.append(f"-mcp={codepage}")
            result = _run_7z([*args, "--", str(path)])
            error = _error_text(result) if result.returncode != 0 else None
            if error and "Unsupported Method" in error and archive_type == "rar" and bandizip():
                shutil.rmtree(dest)
                dest.mkdir(parents=True)
                error = extract_with_bandizip(path, dest)
                record.tool = "bandizip"

        for member in record.members:
            if member.note == "加密，未解开":
                continue
            disk = dest / member.path
            if not disk.resolve().is_relative_to(dest.resolve()) or not disk.is_file():
                member.note = member.note or "未能解出"
                continue
            member.sha256, crc = hash_file(disk)
            # LZH lists a CRC-16 (7-Zip pads it to 8 digits and checks it itself while unpacking).
            if member.crc32 and archive_type != "lzh" and crc != member.crc32:
                member.note = "CRC 校验不符，文件可能已损坏"
        if error:
            record.status, record.error = "error", error
        return record

    def _extract_renaming(self, path: Path, dest: Path, files: list[tuple[Member, bytes]], encoding: str) -> str | None:
        """LZH names come out of 7-Zip as raw bytes: unpack on the Linux disk, then copy with decoded names."""
        with tempfile.TemporaryDirectory(prefix="ra-extract-") as tmp:
            result = _run_7z(["x", "-y", "-p-", "-bso0", "-bsp0", f"-o{tmp}", "--", str(path)])
            tmp_b = os.fsencode(tmp)
            for member, raw in files:
                source = os.path.join(tmp_b, raw)
                if not os.path.isfile(source):
                    continue
                target = dest / member.path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            return _error_text(result) if result.returncode != 0 else None


def _case_collisions(paths: list[str]) -> list[str]:
    seen: dict[str, str] = {}
    out = []
    for p in paths:
        key = p.casefold()
        if key in seen and seen[key] != p:
            out.append(f"{seen[key]} / {p}")
        seen.setdefault(key, p)
    return out


# ------------------------------------------------------------------ encrypted archives


def match_encrypted(records: dict[str, ArchiveRecord], entries: list[ScanEntry], source: Path) -> int:
    """Identify members of encrypted archives with loose files of the same size and CRC32.

    Encrypted members cannot be hashed, but the listing gives their CRC32. A loose file with the same
    size and CRC32 is taken to be the same file; its SHA-256 is recorded with a note saying so.
    """
    by_size: dict[int, list[ScanEntry]] = {}
    for e in entries:
        if e.sha256:
            by_size.setdefault(e.size, []).append(e)
    crc_cache: dict[str, str] = {}
    matched = 0
    for record in records.values():
        if record.status != "encrypted":
            continue
        for m in record.members:
            if m.sha256 or not m.crc32:
                continue
            for e in by_size.get(m.size, []):
                if e.path not in crc_cache:
                    crc_cache[e.path] = hash_file(source / linux_name(e.path))[1]
                if crc_cache[e.path] == m.crc32:
                    m.sha256 = e.sha256
                    m.note = f"加密，未解开；大小与 CRC32 和「{e.path}」相同，视为同一文件"
                    matched += 1
                    break
    return matched


def extract_all(entries: list[ScanEntry], source: Path, out_root: Path, manifest_dir: Path,
                only: str = "", retry: bool = False, workers: int = 3,
                log=lambda msg: print(msg, file=sys.stderr)) -> dict[str, ArchiveRecord]:
    extractor = Extractor(out_root, manifest_dir, log)
    todo: dict[str, ScanEntry] = {}
    for e in entries:
        ext = PurePosixPath(e.path).suffix[1:].lower()
        if ext in TOP_LEVEL_EXTS and e.sha256 and only in e.path:
            todo.setdefault(e.sha256, e)  # identical copies are unpacked once
    log(f"{len(todo)} archives to check ({sum(e.size for e in todo.values()) / 1e9:.1f} GB)")

    def work(e: ScanEntry):
        path = source / linux_name(e.path)
        try:
            if extractor.extract(path, e.sha256, e.path, retry=retry) is None:
                log(f"not an archive  {e.path}")
        except Exception as exc:  # keep going; the archive is retried on the next run
            log(f"      failed  {e.path}: {exc}")

    # Largest first so the long ones overlap with the many small ones.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, sorted(todo.values(), key=lambda e: -e.size)))

    matched = match_encrypted(extractor.records, entries, source)
    for record in extractor.records.values():
        if record.status == "encrypted":
            write_record(manifest_dir, record)
    if matched:
        log(f"matched {matched} encrypted members to loose files by size and CRC32")
    return extractor.records
