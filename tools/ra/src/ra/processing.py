"""Work on stored contents: verifying uploads, making derived files, fingerprints and their matches.

The site keeps the queue (table media_tasks): it lists what each task still needs, a content is claimed
before work starts, and every result or failure is reported back. So the processing container in the
cloud and `uv run ra worker` on a computer can run at the same time without doing anything twice, and a
content that keeps failing is given up after three tries (the admin can start it again).

Originals are read from the local copy of the 合辑 when there is one, else downloaded from storage into
a scratch folder that is emptied after each content.
"""

import hashlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from . import derive as derive_mod
from . import fingerprint as fp_mod
from .push import PART_SIZE
from .site import SiteClient, SiteError

CHECK_VERSION = 1  # uploads: verify, probe, unpack (done = files.checked_at on the site)
TASKS = ("check", "derive", "fingerprint", "clip")
IDLE_PAGES = 30  # pages in a row with nothing claimable (about a minute) end a run
TOUCH_EVERY = 300  # seconds between renewals of a claim (the site treats 20 minutes of silence as a crash)


def unexpected(exc: BaseException) -> str:
    """A one-line account of a bug (an exception nobody planned for): type, message and where."""
    frames = traceback.extract_tb(exc.__traceback__)
    where = f" ({Path(frames[-1].filename).name}:{frames[-1].lineno})" if frames else ""
    return f"程序错误 {type(exc).__name__}: {exc}{where}"[:500]


@contextmanager
def keep_claimed(client: SiteClient, claims: list[tuple[str, str]]):
    """Renew these (task, sha256) claims in the background while the block runs."""
    stop = threading.Event()

    def renew():
        while not stop.wait(TOUCH_EVERY):
            for task, sha in claims:
                try:
                    client.touch(task, sha)
                except Exception:  # never let the renewals stop; a lapsed claim is only redone later
                    pass

    thread = threading.Thread(target=renew, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


@dataclass
class Counts:
    done: int = 0
    failed: int = 0
    skipped: int = 0  # claimed by someone else meanwhile
    errors: list[str] = field(default_factory=list)
    fingerprinted: list[str] = field(default_factory=list)  # new fingerprints, still to be matched
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, other: "Counts") -> None:
        self.done += other.done
        self.failed += other.failed
        self.skipped += other.skipped
        self.errors = (self.errors + other.errors)[-20:]
        self.fingerprinted += other.fingerprinted

    def fail(self, message: str) -> None:
        with self._lock:
            self.failed += 1
            self.errors = (self.errors + [message])[-20:]


class Inputs:
    """Local files for contents: the local copy when ``find`` knows one, else a download."""

    def __init__(self, client: SiteClient, tmp_root: Path | None, find: Callable[[str], Path | None] | None = None):
        self.client, self.tmp_root, self.find = client, tmp_root, find
        if tmp_root:
            tmp_root.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def workdir(self):
        work = Path(tempfile.mkdtemp(prefix="ra-", dir=self.tmp_root))
        try:
            yield work
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def fetch(self, sha256: str, ext: str, work: Path) -> Path:
        local = self.find(sha256) if self.find else None
        if local is not None:
            return local
        dest = work / (f"original.{ext}" if ext else "original")
        if self.client.download(sha256, dest) != sha256:
            raise SiteError("存储里的内容与 SHA-256 不符")
        return dest


def store_output(client: SiteClient, out: derive_mod.Output) -> None:
    """Upload one derived file (whole, or in parts when large)."""
    if out.path is None:
        return
    if out.size <= PART_SIZE:
        data = out.path.read_bytes()
        client.put_object(out.key, data, out.content_type, hashlib.sha256(data).hexdigest())
        return
    upload_id = client.object_multipart(out.key, {"action": "create", "contentType": out.content_type})["uploadId"]
    parts = []
    try:
        with out.path.open("rb") as fh:
            number = 0
            while chunk := fh.read(PART_SIZE):
                number += 1
                parts.append(client.object_part(out.key, upload_id, number, chunk))
        client.object_multipart(out.key, {"action": "complete", "uploadId": upload_id, "parts": parts})
    except BaseException:
        try:
            client.object_multipart(out.key, {"action": "abort", "uploadId": upload_id})
        except SiteError:
            pass
        raise


# ------------------------------------------------------------------ derive


def fingerprint_file(client: SiteClient, sha: str, src: Path, name: str, log) -> str | None:
    """Fingerprint a claimed content from a local file and report it; its SHA-256, or None if it failed."""
    try:
        values = fp_mod.compute(src)
        duration = round(values.size * fp_mod.ITEM_SECONDS, 3)
        client.task_result("fingerprint", sha, fp_mod.FINGERPRINT_VERSION, duration=duration, fp=fp_mod.encode(values))
        return sha
    except Exception as exc:  # see derive_one
        planned = isinstance(exc, (fp_mod.FingerprintError, SiteError, OSError, subprocess.TimeoutExpired))
        message = (str(exc) or type(exc).__name__) if planned else unexpected(exc)
        log(f"      failed  fingerprint {name} ({sha[:12]}…): {message}")
        try:
            client.task_result("fingerprint", sha, fp_mod.FINGERPRINT_VERSION, error=message[:500])
        except SiteError:
            pass
        return None


def derive_one(client: SiteClient, inputs: Inputs, item: dict, log, fingerprinted: list[str] | None = None) -> bool:
    """Derive one claimed content and report it; False when it failed (reported as failed). While the
    original is here anyway, audio and video are also fingerprinted when that is still to do (the SHA-256
    goes to ``fingerprinted``), so each original is downloaded once."""
    sha = item["sha256"]
    try:
        shared = derive_mod.shared_outputs(item)
        if shared is not None:
            outputs = shared  # same decoded audio as a content already done: point at its files
        else:
            with inputs.workdir() as work:
                src = inputs.fetch(sha, item.get("ext") or "", work)
                outputs = derive_mod.derive(src, item, work / "out")
                for out in outputs:
                    store_output(client, out)
                if fingerprinted is not None and item["kind"] in ("audio", "video") \
                        and client.claim("fingerprint", sha, fp_mod.FINGERPRINT_VERSION):
                    if fingerprint_file(client, sha, src, item.get("name") or sha, log):
                        fingerprinted.append(sha)
        client.task_result("derive", sha, derive_mod.DERIVE_VERSION, outputs=[o.report() for o in outputs])
        kinds = ", ".join(o.kind for o in outputs) or "nothing needed"
        log(f"     derived  {item.get('name')}: {kinds}{' (shared)' if shared is not None else ''}")
        return True
    except Exception as exc:  # anything, so one content never stops the others (bugs are reported too)
        planned = isinstance(exc, (derive_mod.DeriveError, SiteError, OSError, subprocess.TimeoutExpired))
        message = (str(exc) or type(exc).__name__) if planned else unexpected(exc)
        log(f"      failed  {item.get('name')} ({sha[:12]}…): {message}")
        try:
            client.task_result("derive", sha, derive_mod.DERIVE_VERSION, error=message[:500])
        except SiteError:
            pass
        return False


def _derive_page(client: SiteClient, limit: int, kind: str | None = None) -> list[dict]:
    page = client.tasks("derive", limit, kind)
    if page["version"] != derive_mod.DERIVE_VERSION:
        raise SiteError(f"网站的推流版规则版本是 {page['version']}，本程序是 {derive_mod.DERIVE_VERSION}：请更新程序")
    return page["items"]


class VideoLane:
    """Videos, one at a time, in a thread of their own. A live recording transcodes for an hour or two;
    without the lane, the audio, images and new uploads queued behind it would wait all that time.

    The processing container keeps one lane while it runs: every round over the queue starts the next
    video when the lane is free (``feed``) and takes what it finished (``collect``); ``on_done`` is called
    when a video is finished, so that the next round comes at once."""

    def __init__(self, client: SiteClient, inputs: Inputs, log=lambda m: print(m, file=sys.stderr),
                 on_done: Callable[[], None] = lambda: None):
        self.client, self.inputs, self.log, self.on_done = client, inputs, log, on_done
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.current: dict | None = None
        self.since = 0.0
        self.finished = Counts()

    @property
    def busy(self) -> bool:
        with self.lock:
            return self.thread is not None and self.thread.is_alive()

    def status(self) -> dict | None:
        with self.lock:
            if self.current is None:
                return None
            return {"name": self.current.get("name") or self.current["sha256"], "since": round(self.since)}

    def feed(self) -> None:
        """Start the next waiting video, unless one is being worked on."""
        if self.busy:
            return
        for item in _derive_page(self.client, 10, "video"):
            if self.client.claim("derive", item["sha256"], derive_mod.DERIVE_VERSION):
                with self.lock:
                    self.current, self.since = item, time.time()
                    self.thread = threading.Thread(target=self._work, args=(item,), daemon=True)
                    self.thread.start()
                self.log(f"       video  {item.get('name')}: started")
                return
            with self.lock:
                self.finished.skipped += 1

    def _work(self, item: dict) -> None:
        new: list[str] = []
        ok = False
        try:
            with keep_claimed(self.client, [("derive", item["sha256"])]):
                ok = derive_one(self.client, self.inputs, item, self.log, new)
        finally:
            with self.lock:
                self.current = None
                if ok:
                    self.finished.done += 1
                else:
                    self.finished.failed += 1
                    self.finished.errors = (self.finished.errors + [f"{item.get('name')}"])[-20:]
                self.finished.fingerprinted += new
            self.on_done()

    def collect(self) -> Counts:
        """What the lane finished since the last call."""
        with self.lock:
            done, self.finished = self.finished, Counts()
        return done

    def wait(self, timeout: float | None = None) -> None:
        with self.lock:
            thread = self.thread
        if thread is not None:
            thread.join(timeout)


def run_derive(client: SiteClient, inputs: Inputs, workers: int = 3, limit: int | None = None,
               log=lambda m: print(m, file=sys.stderr), lane: VideoLane | None = None) -> Counts:
    """Derive everything the site lists (at most ``limit`` contents). With a video lane, videos are handed
    to it and this does the rest; without one, each page's videos are done here after its audio and images."""
    counts = Counts()
    idle_pages = 0
    while limit is None or counts.done + counts.failed < limit:
        if lane is not None:
            lane.feed()
        items = _derive_page(client, 20, "other" if lane is not None else None)
        if limit is not None:
            items = items[: limit - counts.done - counts.failed]
        if not items:
            break
        claimed = [i for i in items if client.claim("derive", i["sha256"], derive_mod.DERIVE_VERSION)]
        counts.skipped += len(items) - len(claimed)
        if not claimed:
            idle_pages += 1
            if idle_pages >= IDLE_PAGES:
                break  # all taken by another worker: leave them to it (the container must be able to idle)
            time.sleep(2)
            continue
        idle_pages = 0
        # Videos use every core by themselves; audio and images run side by side.
        videos = [i for i in claimed if i["kind"] == "video"]
        others = [i for i in claimed if i["kind"] != "video"]
        new: list[str] = []
        with keep_claimed(client, [("derive", i["sha256"]) for i in claimed]):
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(lambda i: derive_one(client, inputs, i, log, new), others))
            results += [derive_one(client, inputs, i, log, new) for i in videos]
        counts.fingerprinted += new
        for item, ok in zip(others + videos, results):
            if ok:
                counts.done += 1
            else:
                counts.fail(f"{item.get('name')}")
    return counts


# ------------------------------------------------------------------ preview clips


def clip_one(client: SiteClient, inputs: Inputs, item: dict, log) -> bool:
    """Cut the preview clips a claimed content still needs, store them and report them; False when it failed."""
    sha = item["sha256"]
    try:
        with inputs.workdir() as work:
            src = inputs.fetch(sha, item.get("ext") or "", work)
            made = derive_mod.clips(src, sha, item["spans"], item.get("format") or {}, bool(item.get("lossless")), work / "out")
            for c in made:
                store_output(client, c.out)
        client.task_result("clip", sha, derive_mod.CLIP_VERSION, clips=[c.report() for c in made])
        log(f"     clipped  {item.get('name')}: {len(item['spans'])} part(s)")
        return True
    except Exception as exc:  # see derive_one
        planned = isinstance(exc, (derive_mod.DeriveError, SiteError, OSError, subprocess.TimeoutExpired))
        message = (str(exc) or type(exc).__name__) if planned else unexpected(exc)
        log(f"      failed  clip {item.get('name')} ({sha[:12]}…): {message}")
        try:
            client.task_result("clip", sha, derive_mod.CLIP_VERSION, error=message[:500])
        except SiteError:
            pass
        return False


def run_clips(client: SiteClient, inputs: Inputs, workers: int = 3, limit: int | None = None,
              log=lambda m: print(m, file=sys.stderr)) -> Counts:
    """Cut the preview clips the site lists (at most ``limit`` contents)."""
    counts = Counts()
    while limit is None or counts.done + counts.failed < limit:
        page = client.tasks("clip", 20)
        if page["version"] != derive_mod.CLIP_VERSION:
            raise SiteError(f"网站的试听片段规则版本是 {page['version']}，本程序是 {derive_mod.CLIP_VERSION}：请更新程序")
        items = page["items"]
        if limit is not None:
            items = items[: limit - counts.done - counts.failed]
        claimed = [i for i in items if client.claim("clip", i["sha256"], derive_mod.CLIP_VERSION, i.get("spec"))]
        counts.skipped += len(items) - len(claimed)
        if not claimed:
            break
        with keep_claimed(client, [("clip", i["sha256"]) for i in claimed]):
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = list(pool.map(lambda i: clip_one(client, inputs, i, log), claimed))
        for item, ok in zip(claimed, results):
            if ok:
                counts.done += 1
            else:
                counts.fail(f"{item.get('name')}")
    return counts


# ------------------------------------------------------------------ fingerprint


def fingerprint_one(client: SiteClient, inputs: Inputs, item: dict, log) -> str | None:
    sha = item["sha256"]
    try:
        with inputs.workdir() as work:
            src = inputs.fetch(sha, item.get("ext") or "", work)
            return fingerprint_file(client, sha, src, item.get("name") or sha, log)
    except Exception as exc:  # see derive_one
        message = (str(exc) or type(exc).__name__) if isinstance(exc, (SiteError, OSError)) else unexpected(exc)
        log(f"      failed  fingerprint {item.get('name')} ({sha[:12]}…): {message}")
        try:
            client.task_result("fingerprint", sha, fp_mod.FINGERPRINT_VERSION, error=message[:500])
        except SiteError:
            pass
        return None


def run_fingerprint(client: SiteClient, inputs: Inputs, workers: int = 4, limit: int | None = None,
                    log=lambda m: print(m, file=sys.stderr), kind: str | None = None) -> tuple[Counts, list[str]]:
    """Fingerprint what the site lists (kind "other": all but videos); returns the counts and the new
    fingerprints' contents."""
    counts, new = Counts(), []
    idle_pages = 0
    while limit is None or counts.done + counts.failed < limit:
        page = client.tasks("fingerprint", 50, kind)
        if page["version"] != fp_mod.FINGERPRINT_VERSION:
            raise SiteError(f"网站的指纹规则版本是 {page['version']}，本程序是 {fp_mod.FINGERPRINT_VERSION}：请更新程序")
        items = page["items"]
        if limit is not None:
            items = items[: limit - counts.done - counts.failed]
        if not items:
            break
        claimed = [i for i in items if client.claim("fingerprint", i["sha256"], fp_mod.FINGERPRINT_VERSION)]
        counts.skipped += len(items) - len(claimed)
        if not claimed:
            idle_pages += 1
            if idle_pages >= IDLE_PAGES:
                break  # see run_derive
            time.sleep(2)
            continue
        idle_pages = 0
        with keep_claimed(client, [("fingerprint", i["sha256"]) for i in claimed]), \
                ThreadPoolExecutor(max_workers=workers) as pool:
            for item, sha in zip(claimed, pool.map(lambda i: fingerprint_one(client, inputs, i, log), claimed)):
                if sha:
                    counts.done += 1
                    new.append(sha)
                else:
                    counts.fail(f"{item.get('name')}")
        log(f"fingerprinted {counts.done} ({counts.failed} failed)")
    return counts, new


def all_fingerprints(client: SiteClient) -> dict:
    prints, after = {}, ""
    while True:
        items, after = client.fingerprints(after, 200)
        for item in items:
            prints[item["sha256"]] = fp_mod.decode(item["fp"])
        if not after:
            return prints


def run_matching(client: SiteClient, new: list[str] | None, log=lambda m: print(m, file=sys.stderr)) -> int:
    """Compare the new fingerprints (None: all of them) with every fingerprint; save the matches."""
    prints = all_fingerprints(client)
    query = sorted(prints) if new is None else [s for s in new if s in prints]
    if not query:
        return 0
    started = time.monotonic()
    matches = [m.report() for m in fp_mod.find_matches(prints, query)]
    log(f"matched {len(query)} of {len(prints)} fingerprints in {time.monotonic() - started:.0f} s: {len(matches)} pairs")
    # Replace the pairs of the compared contents, in chunks the site accepts.
    shas = None if new is None else query
    if not matches:
        client.matches(shas, [])
        return 0
    first = True
    for i in range(0, len(matches), 500):
        client.matches(shas if first else [], matches[i:i + 500])
        first = False
    return len(matches)
