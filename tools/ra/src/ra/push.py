"""Upload the 合辑's contents to the site's storage (`uv run ra push`).

The site says which contents it wants (every file not stored yet, third-party ones included; only
ignored files stay out), this finds each one in the local copy (source/ or
extracted/) and stores it under blobs/<sha256>, then tells the site, which fills in blob_key.

Safe to interrupt and re-run: contents already stored are only marked, and large files continue from
the parts already sent (progress in manifest/push-state.json).
"""

import hashlib
import json
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

from .serve import content_type
from .site import SiteClient, SiteError

PART_SIZE = 50 * 1024 * 1024  # the site's PART_SIZE: whole files up to this, parts of this size above
HAVE_BATCH = 100


class LocalMismatch(Exception):
    """The local file no longer has the content it was hashed with."""


class PushState:
    """Multipart uploads in progress, so an interrupted large file continues where it stopped."""

    def __init__(self, path: Path | None):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, dict] = {}
        if path and path.exists():
            self._data = json.loads(path.read_text(encoding="utf-8"))

    def get(self, sha256: str) -> dict | None:
        with self._lock:
            entry = self._data.get(sha256)
            return json.loads(json.dumps(entry)) if entry else None

    def save(self, sha256: str, upload_id: str, parts: list[dict]) -> None:
        with self._lock:
            self._data[sha256] = {"uploadId": upload_id, "parts": parts}
            self._write()

    def drop(self, sha256: str) -> None:
        with self._lock:
            if self._data.pop(sha256, None) is not None:
                self._write()

    def _write(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data), encoding="utf-8")
        tmp.replace(self.path)


def upload_file(client: SiteClient, sha256: str, path: Path, ctype: str, state: PushState,
                sent: Callable[[int], None] = lambda n: None) -> None:
    """Store one local file as blobs/<sha256>, checking that it still has that content."""
    size = path.stat().st_size
    if size <= PART_SIZE:
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != sha256:
            raise LocalMismatch(path)
        client.put_blob(sha256, data, ctype)  # storage checks the SHA-256 too
        sent(size)
        return

    entry = state.get(sha256)
    upload_id = entry["uploadId"] if entry else client.multipart_create(sha256, ctype)
    parts = {p["partNumber"]: p for p in entry["parts"]} if entry else {}
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        number = 0
        while chunk := fh.read(PART_SIZE):
            number += 1
            digest.update(chunk)
            if number in parts:
                sent(len(chunk))
                continue
            try:
                parts[number] = client.multipart_part(sha256, upload_id, number, chunk)
            except SiteError:
                if entry is None:
                    raise
                state.drop(sha256)  # the old upload expired (storage drops them after 7 days): start over
                return upload_file(client, sha256, path, ctype, state, sent)
            state.save(sha256, upload_id, list(parts.values()))
            sent(len(chunk))
    if digest.hexdigest() != sha256:
        client.multipart_abort(sha256, upload_id)
        state.drop(sha256)
        raise LocalMismatch(path)
    try:
        client.multipart_complete(sha256, upload_id, sorted(parts.values(), key=lambda p: p["partNumber"]))
    except SiteError:
        if client.have([sha256]).get(sha256) != size:  # a retried complete fails after the first one worked
            raise
    state.drop(sha256)


@dataclass
class Progress:
    files: int
    bytes: int
    done_files: int = 0
    done_bytes: int = 0
    failed: list[str] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, n: int) -> None:
        with self._lock:
            self.done_bytes += n

    def line(self) -> str:
        elapsed = max(time.monotonic() - self.started, 1e-6)
        rate = self.done_bytes / elapsed
        left = (self.bytes - self.done_bytes) / rate if rate > 0 else 0
        eta = f"{int(left // 3600)}h{int(left % 3600 // 60):02d}m" if rate > 0 else "?"
        pct = self.done_bytes / self.bytes * 100 if self.bytes else 100
        return (f"{self.done_bytes / 1e9:.2f}/{self.bytes / 1e9:.2f} GB ({pct:.1f}%), "
                f"{self.done_files}/{self.files} files, {rate / 1e6:.1f} MB/s, ETA {eta}")


class StoredMarker:
    """Tells the site which contents are stored, in batches."""

    def __init__(self, client: SiteClient):
        self.client = client
        self.pending: list[str] = []
        self.marked = 0
        self._lock = threading.Lock()

    def add(self, sha256: str) -> None:
        with self._lock:
            self.pending.append(sha256)
            batch = self.pending if len(self.pending) >= 50 else None
            if batch:
                self.pending = []
        if batch:
            self._send(batch)

    def flush(self) -> None:
        with self._lock:
            batch, self.pending = self.pending, []
        for i in range(0, len(batch), HAVE_BATCH):
            self._send(batch[i:i + HAVE_BATCH])

    def _send(self, batch: list[str]) -> None:
        n = self.client.stored(batch)
        with self._lock:
            self.marked += n


def wanted_items(client: SiteClient) -> list[dict]:
    items, after = [], ""
    while True:
        page, after = client.wanted(after, 500)
        items.extend(page)
        if not after:
            return items


def push(client: SiteClient, find: Callable[[str], Path | None], state: PushState, workers: int = 4,
         dry_run: bool = False, limit: int | None = None, log=lambda msg: print(msg, file=sys.stderr),
         report_every: float = 30) -> Progress:
    items = wanted_items(client)
    log(f"site wants {len(items)} contents ({sum(i['size'] for i in items) / 1e9:.2f} GB)")

    # Contents stored by an earlier, interrupted run only need marking.
    marker = StoredMarker(client)
    have: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for part in pool.map(client.have, [[i["sha256"] for i in items[k:k + HAVE_BATCH]] for k in range(0, len(items), HAVE_BATCH)]):
            have |= part
    already = [i for i in items if have.get(i["sha256"]) == i["size"]]
    if already and not dry_run:
        for i in already:
            marker.add(i["sha256"])
        marker.flush()
        log(f"{len(already)} were already stored; marked")

    todo, missing = [], []
    for i in items:
        if have.get(i["sha256"]) == i["size"]:
            continue
        path = find(i["sha256"])
        (todo if path else missing).append((i, path))
    if limit is not None:
        todo = todo[:limit]
    progress = Progress(files=len(todo), bytes=sum(i["size"] for i, _ in todo))
    if missing:
        log(f"{len(missing)} contents are not in the local copy (skipped), e.g. {missing[0][0]['name']}")
    log(f"to upload: {progress.files} files, {progress.bytes / 1e9:.2f} GB")
    if dry_run or not todo:
        return progress

    stop = threading.Event()

    def reporter():
        while not stop.wait(report_every):
            log(progress.line())

    def work(item: dict, path: Path) -> None:
        upload_file(client, item["sha256"], path, content_type(Path(item["name"])), state, progress.add)
        marker.add(item["sha256"])

    threading.Thread(target=reporter, daemon=True).start()
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = {pool.submit(work, i, p): (i, p) for i, p in todo}
        for future in as_completed(futures):
            item, path = futures[future]
            try:
                future.result()
                progress.done_files += 1
            except (SiteError, LocalMismatch, OSError) as exc:
                progress.failed.append(item["sha256"])
                why = "本地文件与记录的 SHA-256 不符（被改动过？）" if isinstance(exc, LocalMismatch) else exc
                log(f"      failed  {path}: {why}")
    except KeyboardInterrupt:
        log("interrupted; finishing the files in flight (Ctrl-C again to quit at once)")
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        stop.set()
        marker.flush()
        log(progress.line())
    return progress
