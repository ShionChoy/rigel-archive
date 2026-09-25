"""The processing program inside the Cloudflare container (`ra container`, the image's entry point).

The site's Worker starts the container when there is work (see site/src/processor.ts) and talks to it
over HTTP on PORT:

  GET  /ping     the container is up
  GET  /status   what it is doing (the Worker asks before letting an idle container stop)
  POST /wake     look at the queue now; ?backup=1 also runs the backup

The program works through the queue (processing.py, worker.py) and waits for the next wake when it is
empty; the Worker stops the container once it has been idle for a while. It reaches the site as
http://site.internal, which the Worker answers itself, so no secrets are needed for that; the backup's
B2 key and encryption passwords arrive as environment variables when they are set.
"""

import json
import signal
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import backup as backup_mod
from .site import INTERNAL_SITE, SiteClient, SiteError
from .worker import run_cycle
from .processing import TASKS, Inputs, VideoLane

IDLE_RECHECK = 300  # seconds between looks at the queue while nothing wakes it


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, file=sys.stdout, flush=True)


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.busy = False
        self.task = ""
        self.started = time.time()
        self.progress_at = time.time()
        self.backup_requested = False
        self.done = 0
        self.failed = 0
        self.errors: list[str] = []
        self.last_backup: dict | None = None
        self.lane: VideoLane | None = None  # videos transcode in their own thread (see VideoLane)

    def update(self, **fields) -> None:
        with self.lock:
            for key, value in fields.items():
                setattr(self, key, value)
            self.progress_at = time.time()

    def snapshot(self) -> dict:
        with self.lock:
            lane = self.lane
            return {
                "busy": self.busy or (lane is not None and lane.busy), "task": self.task,
                "video": lane.status() if lane is not None else None, "up_since": round(self.started),
                "progress_at": round(self.progress_at), "done": self.done, "failed": self.failed,
                "errors": self.errors[-10:], "backup_requested": self.backup_requested,
                "last_backup": self.last_backup,
            }


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ra-container"

        def log_message(self, fmt, *args):
            pass

        def _send(self, code: int, body: dict | str) -> None:
            data = (json.dumps(body) if isinstance(body, dict) else body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json" if isinstance(body, dict) else "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/ping":
                return self._send(200, "ok")
            if path == "/status":
                return self._send(200, state.snapshot())
            return self._send(404, "not found")

        def do_POST(self):
            url = urlsplit(self.path)
            if url.path != "/wake":
                return self._send(404, "not found")
            if parse_qs(url.query).get("backup") == ["1"]:
                state.update(backup_requested=True)
            state.wake.set()
            return self._send(200, state.snapshot())

    return Handler


def work_loop(state: State, client: SiteClient, tmp: Path, workers: int) -> None:
    inputs = Inputs(client, tmp)
    # A finished video wakes the loop: its matches are looked for and the next video is started.
    state.lane = VideoLane(client, inputs, log=lambda m: (log(m), state.update()), on_done=state.wake.set)
    while True:
        state.wake.wait(timeout=IDLE_RECHECK)
        state.wake.clear()
        state.update(busy=True, task="queue")
        try:
            while True:
                counts = run_cycle(client, inputs, None, tmp, TASKS, workers,
                                   log=lambda m: (log(m), state.update(task=m[:200])), video_lane=state.lane)
                with state.lock:
                    state.done += counts.done
                    state.failed += counts.failed
                    state.errors = (state.errors + counts.errors)[-20:]
                if state.backup_requested:
                    state.update(backup_requested=False, task="backup")
                    try:
                        report = backup_mod.run(client, None, tmp, log=lambda m: (log(m), state.update(task=f"backup: {m[:180]}")))
                        state.update(last_backup={"ok": True, "at": round(time.time()), **report.get("blobs", {})})
                    except backup_mod.BackupError as exc:
                        log(f"backup failed: {exc}")
                        state.update(last_backup={"ok": False, "at": round(time.time()), "error": str(exc)[:300]})
                if counts.done == 0 and counts.failed == 0:
                    break
        except SiteError as exc:
            log(f"cannot reach the site: {exc}")
            time.sleep(30)
            state.wake.set()  # try again
        except Exception as exc:  # keep the container serving /status whatever happens; the error is logged
            log(traceback.format_exc())
            from .processing import unexpected

            with state.lock:
                state.errors = (state.errors + [unexpected(exc)])[-20:]
            time.sleep(60)
        finally:
            state.update(busy=False, task="")


def main(port: int, tmp: Path, workers: int = 3) -> int:
    client = SiteClient(INTERNAL_SITE, "")
    state = State()
    state.wake.set()  # look at the queue right after starting
    threading.Thread(target=work_loop, args=(state, client, tmp, workers), daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(state))

    def stop(signum, _frame):
        # The Worker stops an idle container (or restarts it) with SIGTERM. Work in hand is simply dropped:
        # its claims lapse after 20 minutes and the next run picks it up again.
        log(f"stopping on signal {signum} (busy: {state.busy})")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log(f"processing container listening on :{port}")
    server.serve_forever()
    return 0
