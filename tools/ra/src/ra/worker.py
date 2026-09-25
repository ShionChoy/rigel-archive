"""The processing program: works through the site's queue (`uv run ra worker`, and in the cloud the
processing container, see container.py).

Uploads live in the site's storage (R2). For each uploaded content it downloads the bytes once, checks
them against the SHA-256 (large uploads arrive in parts, which storage does not check as a whole), and
then

  - reads audio/video/image specs with the same code as `ra probe`;
  - unpacks archives with the same code as `ra extract`, stores every member's content and adds the
    members to the 整理台 (inside the archive's folder, in the same upload batch).

Then it makes the files for playing and previewing (derive.py) and the acoustic fingerprints
(fingerprint.py) of everything stored, see processing.py. Downloads go to a temporary folder that is
emptied afterwards, unless --keep names a folder for copies of uploads. It talks to the site only over
HTTP (see site.py), so the same program serves the local dev site and the deployed one.
"""

import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

from .extract import MAX_DEPTH, TOP_LEVEL_EXTS, ArchiveRecord, Extractor
from .members import archive_format
from .model import kind_for
from .probe import PROBE_KINDS, probe_one
from .processing import (CHECK_VERSION, TASKS, Counts, Inputs, VideoLane, keep_claimed, run_derive,
                         run_fingerprint, run_matching, unexpected)
from .push import PushState, upload_file
from .serve import content_type
from .site import SiteError

UNPACK_EXTS = TOP_LEVEL_EXTS | {"exe"}  # an .exe is unpacked only when 7-Zip opens it as an archive


def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _probe(sha256: str, path: Path) -> dict:
    probed = probe_one(sha256, path)
    fmt = dict(probed.get("format") or {})
    if "error" in probed:
        fmt["probe_error"] = probed["error"]
    return {"format": fmt or None, "pcm_md5": probed.get("pcm_md5")}


def _walk(record: ArchiveRecord, records: dict[str, ArchiveRecord], out_root: Path, prefix: str, parent: str,
          depth: int):
    """(member dict for the site, local file or None) for an archive and the archives inside it."""
    for m in record.members:
        inner = records.get(m.sha256) if m.sha256 and depth < MAX_DEPTH else None
        path = prefix + m.path
        local = out_root / record.dir_name / m.path if m.sha256 else None
        item = {"path": path, "parent": parent, "size": m.size, "mtime": m.mtime, "sha256": m.sha256,
                "note": m.note, "format": archive_format(inner) if inner else None, "pcm_md5": None}
        yield item, local
        if inner:
            yield from _walk(inner, records, out_root, f"{path}!/", path, depth + 1)


def unpack(client, sha256: str, path: Path, name: str, work: Path, log, workers: int = 4) -> dict:
    """Unpack an uploaded archive, store and register its members; returns the archive's result."""
    extractor = Extractor(work / "unpacked", work / "records", log=lambda msg: None)
    record = extractor.extract(path, sha256, name)
    if record is None:
        if PurePosixPath(name).suffix.lower() == ".exe":
            return {}  # an ordinary program: kept as a file, never run
        return {"format": {"archive": PurePosixPath(name).suffix[1:].lower(), "files": 0, "status": "error",
                           "error": "7-Zip 无法作为压缩包打开"}}
    members = list(_walk(record, extractor.records, work / "unpacked", "", "", 1))

    # Store each distinct content once, and read the specs of media files.
    local = {item["sha256"]: disk for item, disk in members if item["sha256"] and disk and disk.is_file()}
    have: dict[str, int] = {}
    shas = list(local)
    for i in range(0, len(shas), 100):
        have |= client.have(shas[i:i + 100])
    names = {item["sha256"]: PurePosixPath(item["path"]).name for item, _ in members if item["sha256"]}
    state = PushState(None)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        uploads = [pool.submit(upload_file, client, s, p, content_type(Path(names[s])), state)
                   for s, p in local.items() if have.get(s) != p.stat().st_size]
        probes = {s: pool.submit(_probe, s, p) for s, p in local.items()
                  if kind_for(PurePosixPath(names[s]).suffix[1:].lower()) in PROBE_KINDS}
        for f in uploads:
            f.result()
        specs = {s: f.result() for s, f in probes.items()}
    for item, _ in members:
        spec = specs.get(item["sha256"])
        if spec and item["format"] is None:
            item["format"], item["pcm_md5"] = spec["format"], spec["pcm_md5"]
        if item["sha256"] and item["sha256"] not in local:
            item["sha256"] = None  # listed but not unpacked (e.g. matched only by CRC): nothing stored
    client.register_members(sha256, [item for item, _ in members])
    log(f"    unpacked  {name}: {len(members)} files, {len(local)} distinct contents")
    return {"format": archive_format(record)}


def process(client, job: dict, store: Path | None, tmp_root: Path | None = None,
            log=lambda msg: print(msg, file=sys.stderr)) -> dict:
    """Verify one uploaded content, then probe or unpack it; returns what was reported to the site."""
    sha = job["sha256"]
    ext = (job.get("ext") or "").lower()
    filename = f"{sha}.{ext}" if ext else sha
    if tmp_root:
        tmp_root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="ra-worker-", dir=tmp_root))
    try:
        dest = (store / filename) if store else (work / filename)
        if not (dest.exists() and _sha256_file(dest) == sha):
            if client.download(sha, dest) != sha:
                dest.unlink()
                result = {"error": "存储里的内容与 SHA-256 不符，请重新上传"}
                client.report(sha, **result)
                return result
        result: dict = {}
        if kind_for(ext) in PROBE_KINDS:
            result = _probe(sha, dest)
        elif ext in UNPACK_EXTS:
            result = unpack(client, sha, dest, job.get("name") or filename, work, log)
        client.report(sha, **result)
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_checks(client, store: Path | None, tmp_root: Path | None = None,
               log=lambda msg: print(msg, file=sys.stderr)) -> Counts:
    """Verify, probe and unpack every upload the site lists."""
    counts = Counts()
    while True:
        jobs = client.jobs()
        claimed = [j for j in jobs if client.claim("check", j["sha256"], CHECK_VERSION)]
        counts.skipped += len(jobs) - len(claimed)
        if not claimed:
            return counts
        for job in claimed:
            try:
                with keep_claimed(client, [("check", job["sha256"])]):
                    result = process(client, job, store, tmp_root, log)
            except Exception as exc:  # one upload never stops the others; bugs are reported too
                message = str(exc) if isinstance(exc, (SiteError, OSError)) else unexpected(exc)
                counts.fail(f"{job['name']}: {message}")
                log(f"      failed  {job['name']}: {message}")
                try:
                    client.task_result("check", job["sha256"], CHECK_VERSION, error=message[:500])
                except SiteError:
                    pass
                continue
            counts.done += 1
            state = "wrong hash" if "error" in result else "ok"
            log(f"{state:>12}  {job['name']} ({job['sha256'][:12]}…)")


def run_cycle(client, inputs: Inputs, store: Path | None, tmp_root: Path | None, tasks=TASKS, workers: int = 3,
              log=lambda msg: print(msg, file=sys.stderr), video_lane: VideoLane | None = None) -> Counts:
    """One round over the queue: all uploads, then a batch of derived files, then a batch of
    fingerprints and their matches. Returns what was done; nothing done means the queue is empty (a
    video may still be going in ``video_lane``: what it finished counts in the round that collects it)."""
    total = Counts()
    if "check" in tasks:
        total.add(run_checks(client, store, tmp_root, log))
    new: list[str] = []
    if "derive" in tasks:
        counts = run_derive(client, inputs, workers=workers, limit=60, log=log, lane=video_lane)
        if video_lane is not None:
            counts.add(video_lane.collect())
        total.add(counts)
        new += counts.fingerprinted  # audio and video are fingerprinted while being derived
    if "fingerprint" in tasks:
        # While the lane transcodes a video, the videos still to fingerprint are left to it: it fingerprints
        # them from the download it has anyway (a live recording is gigabytes).
        lane_busy = video_lane is not None and video_lane.busy
        counts, more = run_fingerprint(client, inputs, workers=max(workers, 2), limit=300, log=log,
                                       kind="other" if lane_busy else None)
        total.add(counts)
        new += more
    if new and "fingerprint" in tasks:
        run_matching(client, new, log=log)
    return total


def run(client, store: Path | None, tmp_root: Path | None = None, once: bool = False, interval: float = 10,
        log=lambda msg: print(msg, file=sys.stderr), tasks=TASKS, workers: int = 3,
        find=None) -> int:
    """Work through the queue; with once=False keep polling until interrupted. Returns how many were done."""
    inputs = Inputs(client, tmp_root, find)
    done = 0
    while True:
        try:
            counts = run_cycle(client, inputs, store, tmp_root, tasks, workers, log)
        except SiteError as exc:
            log(f"cannot reach the site: {exc}")
            if once:
                return done
            time.sleep(interval)
            continue
        done += counts.done
        if counts.done == 0 and counts.failed == 0:
            if once:
                return done
            time.sleep(interval)
