"""Read-only local file server for admin previews during development (`uv run ra serve`).

Serves GET/HEAD with Range support (audio/video seeking) and CORS for the dev admin:

  /source/<path>          a file in the source tree
  /blob/<sha256>/<name>   any file by content, loose or unpacked by `ra extract`; the name only sets
                          the content type (production serves the same content-addressed keys from R2)

Binds to 127.0.0.1 only and refuses paths that resolve outside the served roots.
"""

import mimetypes
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .extract import load_records, local_copies
from .scan import linux_name, load_scan

_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
_BLOB = re.compile(r"^/blob/([0-9a-f]{64})(?:/.*)?$")
_EXTRA_TYPES = {
    ".flac": "audio/flac", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".mkv": "video/x-matroska",
    ".webm": "video/webm", ".mid": "audio/midi", ".webp": "image/webp",
}


def content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in _EXTRA_TYPES:
        return _EXTRA_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Return (start, end) inclusive, or None for the whole file. Raises ValueError if unsatisfiable."""
    if not header:
        return None
    m = _RANGE.match(header.strip())
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return None
    if m.group(1) == "":
        length = int(m.group(2))
        if length == 0:
            raise ValueError("empty suffix range")
        return max(size - length, 0), size - 1
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else size - 1
    if start >= size or end < start:
        raise ValueError("unsatisfiable range")
    return start, min(end, size - 1)


class BlobIndex:
    """SHA-256 -> local file, from the scan and the `ra extract` records. Reloads when a hash is unknown."""

    RELOAD_AFTER = 10.0  # seconds

    def __init__(self, source: Path, scan: Path, extracted: Path, archives: Path):
        self.source, self.scan, self.extracted, self.archives = source, scan, extracted, archives
        self._paths: dict[str, Path] = {}
        self._loaded = float("-inf")
        self._lock = threading.Lock()

    def _load(self) -> None:
        self._paths = local_copies(self.source, load_scan(self.scan), load_records(self.archives), self.extracted)
        self._loaded = time.monotonic()

    def find(self, sha256: str) -> Path | None:
        with self._lock:
            path = self._paths.get(sha256)
            if path is None and time.monotonic() - self._loaded > self.RELOAD_AFTER:
                self._load()
                path = self._paths.get(sha256)
        return path if path is not None and path.is_file() else None


def make_handler(root: Path, blobs: BlobIndex | None = None):
    root = root.resolve()

    class Handler(BaseHTTPRequestHandler):
        server_version = "ra-serve"

        def log_message(self, fmt, *args):  # keep the terminal quiet
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Range")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_HEAD(self):
            self._serve(send_body=False)

        def do_GET(self):
            self._serve(send_body=True)

        def _error(self, code: int):
            self.send_response(code)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _target(self) -> tuple[Path, str] | None:
            """(file, name for the content type) or None."""
            url_path = unquote(urlsplit(self.path).path)
            if url_path.startswith("/source/"):
                target = (root / linux_name(url_path[len("/source/"):])).resolve()
                return (target, target.name) if target.is_relative_to(root) and target.is_file() else None
            m = _BLOB.match(url_path)
            if m and blobs is not None:
                target = blobs.find(m.group(1))
                return (target, url_path.rsplit("/", 1)[-1]) if target else None
            return None

        def _serve(self, send_body: bool):
            found = self._target()
            if found is None:
                return self._error(404)
            target, name = found
            size = target.stat().st_size
            try:
                byte_range = parse_range(self.headers.get("Range"), size)
            except ValueError:
                self.send_response(416)
                self._cors()
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            start, end = byte_range if byte_range else (0, size - 1)
            length = max(end - start + 1, 0)
            self.send_response(206 if byte_range else 200)
            self._cors()
            self.send_header("Content-Type", content_type(Path(name)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            if byte_range:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if not send_body or length == 0:
                return
            with target.open("rb") as fh:
                fh.seek(start)
                remaining = length
                try:
                    while remaining > 0:
                        chunk = fh.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the browser stopped reading (normal while seeking)

    return Handler


def serve(root: Path, port: int, blobs: BlobIndex | None = None) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(root, blobs))
    print(f"serving {root} and unpacked archives read-only at http://127.0.0.1:{port}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

