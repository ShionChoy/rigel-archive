"""Derived files, fingerprints, the processing queue and the backup.

Tests that need ffmpeg's FLAC tools (metaflac) or rclone are skipped where those are missing; the
processing container's image has them all:

  docker build -t ra-processor tools/ra
  docker run --rm -v "$PWD/tools/ra:/src" -w /src --entrypoint sh ra-processor -c 'uv run --with pytest pytest -q'
"""

import gzip
import hashlib
import io
import json
import re
import shutil
import sqlite3
import subprocess
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from ra import derive
from ra import fingerprint as fp
from ra.cli import REPO

needs_flac = pytest.mark.skipif(shutil.which("metaflac") is None, reason="needs metaflac (the container image has it)")
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
needs_rclone = pytest.mark.skipif(shutil.which("rclone") is None, reason="needs rclone (the container image has it)")


def music(seconds: float, seed: int, rate: int = 44100) -> np.ndarray:
    """A stereo 16-bit 'melody': random chords changing every quarter second (rich in chroma)."""
    rng = np.random.default_rng(seed)
    step = int(rate / 4)
    out = []
    for _ in range(int(seconds * 4)):
        t = np.arange(step) / rate
        notes = 220 * 2 ** (rng.integers(0, 36, size=3) / 12)
        chord = sum(np.sin(2 * np.pi * f * t) for f in notes) / 3
        out.append(chord * np.hanning(step) ** 0.2)
    mono = np.concatenate(out) * 0.6 * 32767
    return np.stack([mono, mono * 0.9], axis=1).astype("<i2")


def write_wav(path: Path, samples: np.ndarray, rate: int = 44100) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(samples.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return path


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- versions shared with the site


def test_task_versions_match_the_site():
    from ra.processing import CHECK_VERSION

    ts = (REPO / "site" / "src" / "lib" / "processing.ts").read_text(encoding="utf-8")
    versions = dict(re.findall(r"(\w+): (\d+)", ts.split("TASK_VERSIONS = {", 1)[1].split("}", 1)[0]))
    assert versions == {"check": str(CHECK_VERSION), "derive": str(derive.DERIVE_VERSION),
                        "fingerprint": str(fp.FINGERPRINT_VERSION), "clip": str(derive.CLIP_VERSION)}


def test_derived_keys_match_the_site_pattern():
    ts = (REPO / "site" / "src" / "lib" / "blobs.ts").read_text(encoding="utf-8")
    pattern = re.search(r"DERIVED_KEY = /(.+)/;", ts).group(1).replace("\\/", "/")
    s = "a" * 64
    for key in (f"derived/stream/{s}.flac", f"derived/stream/{s}.m4a", f"derived/wave/{s}.json",
                f"derived/img/{s}/240.webp", f"derived/video/{s}/720p.mp4", f"derived/video/{s}/poster.webp",
                f"derived/clip/{s}/30000-75000.flac", f"derived/clip/{s}/0-60000.m4a"):
        assert re.fullmatch(pattern, key), key
    assert not re.fullmatch(pattern, f"derived/stream/{s}/../x")


# ---------------------------------------------------------------- derive


@needs_flac
def test_wav_becomes_a_bit_exact_stream_flac_with_seek_table(tmp_path):
    from ra.probe import probe_one

    src = write_wav(tmp_path / "a.wav", music(40, 1))
    probed = probe_one(sha(src), src)
    item = {"sha256": sha(src), "kind": "audio", "format": probed["format"], "pcm_md5": probed["pcm_md5"]}
    outputs = {o.kind: o for o in derive.derive(src, item, tmp_path / "out")}
    assert set(outputs) == {"stream", "aac", "wave"}
    stream = outputs["stream"]
    layout = derive.flac_layout(stream.path)
    assert layout.seektable and layout.bits == 16 and layout.rate == 44100
    assert derive.flac_md5(stream.path) == probed["pcm_md5"]  # every sample survived
    assert stream.key == f"derived/stream/{item['sha256']}.flac"
    wave_data = json.loads(outputs["wave"].path.read_text())
    assert len(wave_data["peaks"]) == derive.WAVE_POINTS and max(wave_data["peaks"]) > 100
    assert outputs["aac"].info["kbps"] == 256


@needs_flac
def test_clean_flac_streams_as_it_is_and_shares_by_pcm(tmp_path):
    src = write_wav(tmp_path / "a.wav", music(35, 2))
    flac = tmp_path / "a.flac"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-c:a", "flac", str(flac)], check=True)
    subprocess.run(["metaflac", "--add-seekpoint=10s", str(flac)], check=True)
    fmt = {"codec": "flac", "lossless": True, "bits": 16, "rate": 44100, "channels": 2, "duration": 35}
    out = derive.stream_flac(flac, sha(flac), fmt, None, tmp_path)
    assert out.path is None and out.key == f"blobs/{sha(flac)}" and out.info["original"]

    # a WAV with the same decoded audio as a derived content only points at its files
    shared = {"stream": {"key": "derived/stream/x.flac", "size": 10, "info": {}},
              "aac": {"key": "derived/stream/x.m4a", "size": 5, "info": {}},
              "wave": {"key": "derived/wave/x.json", "size": 2, "info": {}}}
    wav_item = {"sha256": "b" * 64, "kind": "audio", "format": {"codec": "pcm_s16le", "lossless": True}, "shared": shared}
    assert [o.kind for o in derive.shared_outputs(wav_item)] == ["aac", "stream", "wave"]
    mp3_item = {"sha256": "c" * 64, "kind": "audio", "format": {"codec": "mp3"}, "shared": {"wave": shared["wave"]}}
    assert [o.kind for o in derive.shared_outputs(mp3_item)] == ["wave"]  # MP3 streams as it is


def test_images_get_webp_sizes_but_are_never_enlarged(tmp_path):
    from PIL import Image

    big = tmp_path / "scan.png"
    Image.new("RGB", (2000, 1000), (200, 10, 10)).save(big)
    small = tmp_path / "icon.gif"
    Image.new("P", (100, 60)).save(small)
    out = {o.kind: o.info for o in derive.derive(big, {"sha256": "a" * 64, "kind": "image"}, tmp_path / "b")}
    assert out == {"img240": {"width": 240, "height": 120}, "img640": {"width": 640, "height": 320},
                   "img1600": {"width": 1600, "height": 800}}
    out = {o.kind: o.info for o in derive.derive(small, {"sha256": "b" * 64, "kind": "image"}, tmp_path / "s")}
    assert out == {"img240": {"width": 100, "height": 60}}


def test_large_pictures_also_get_a_jpeg_to_embed(tmp_path, monkeypatch):
    """A picture of 12 MB or more (a booklet scan) is too large to embed into a download as the cover:
    it also gets a 1600 px JPEG («embed»); smaller ones do not."""
    from PIL import Image

    scan = tmp_path / "scan.png"
    Image.new("RGB", (3000, 2000), (20, 90, 200)).save(scan)
    monkeypatch.setattr(derive, "EMBED_MIN_BYTES", scan.stat().st_size)
    out = {o.kind: o for o in derive.derive(scan, {"sha256": "d" * 64, "kind": "image"}, tmp_path / "e")}
    assert out["embed"].key == f"derived/img/{'d' * 64}/embed.jpg" and out["embed"].info == {"width": 1600, "height": 1067}
    assert Image.open(out["embed"].path).format == "JPEG"
    monkeypatch.setattr(derive, "EMBED_MIN_BYTES", scan.stat().st_size + 1)
    assert "embed" not in {o.kind for o in derive.derive(scan, {"sha256": "d" * 64, "kind": "image"}, tmp_path / "f")}


@needs_ffmpeg
def test_browser_friendly_video_is_remuxed_and_others_transcoded(tmp_path):
    h264 = tmp_path / "a.mkv"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
                    "-f", "lavfi", "-i", "sine=duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "libopus", str(h264)], check=True)
    mpeg4 = tmp_path / "b.avi"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=321x241:rate=25:duration=4",
                    "-c:v", "mpeg4", str(mpeg4)], check=True)
    out = {o.kind: o for o in derive.derive(h264, {"sha256": "a" * 64, "kind": "video"}, tmp_path / "x")}
    assert out["video"].info["remuxed"] is True and out["video"].info["acodec"] == "aac"
    assert out["video"].key.endswith("/240p.mp4") and out["poster"].info["width"] == 320
    out = {o.kind: o for o in derive.derive(mpeg4, {"sha256": "b" * 64, "kind": "video"}, tmp_path / "y")}
    assert out["video"].info["remuxed"] is False and out["video"].info["width"] == 320  # made even for H.264
    assert "acodec" not in out["video"].info


# ---------------------------------------------------------------- fingerprints


@needs_ffmpeg
def test_fingerprints_find_encodings_and_tracks_inside_longer_files(tmp_path):
    track = music(60, 7)
    other = music(60, 8)
    album = np.concatenate([music(45, 9), track, music(30, 10)])
    files = {
        "track": write_wav(tmp_path / "track.wav", track),
        "other": write_wav(tmp_path / "other.wav", other),
        "album": write_wav(tmp_path / "album.wav", album),
    }
    mp3 = tmp_path / "track.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(files["track"]), "-b:a", "128k", str(mp3)], check=True)
    files["mp3"] = mp3
    prints = {name: fp.compute(path) for name, path in files.items()}
    assert fp.decode(fp.encode(prints["track"])).tolist() == prints["track"].tolist()

    matches = {(m.a, m.b): m for m in fp.find_matches(prints, list(prints))}
    assert ("mp3", "track") in matches and matches[("mp3", "track")].score > 0.9
    assert abs(matches[("mp3", "track")].offset_ms) < 500
    inside = matches[("album", "track")]
    assert abs(inside.offset_ms - (-45_000)) < 1000  # the track starts 45 s into the album
    assert inside.matched_ms > 50_000
    assert not any("other" in pair for pair in matches)


# ---------------------------------------------------------------- the queue, against a fake site


class QueueSite:
    """The site's task endpoints over httpx.MockTransport."""

    def __init__(self, items):
        self.items = items  # task -> list of items
        self.claims: dict[tuple, int] = {}
        self.running: set[tuple] = set()  # claimed and not reported yet: the site does not list them
        self.results: dict[tuple, dict] = {}
        self.objects: dict[str, bytes] = {}
        self.blobs: dict[str, bytes] = {}
        self.fingerprints: dict[str, dict] = {}
        self.pairs: list[dict] = []

    def client(self):
        import httpx

        from ra.site import SiteClient

        return SiteClient("https://site.test", "t", transport=httpx.MockTransport(self.handle), retries=0)

    def handle(self, request):
        import httpx

        path = request.url.path.removeprefix("/admin/api/worker/")
        body = json.loads(request.content) if request.headers.get("content-type") == "application/json" else None
        if path == "tasks":
            task = request.url.params["task"]
            version = {"derive": derive.DERIVE_VERSION, "clip": derive.CLIP_VERSION}.get(task, fp.FINGERPRINT_VERSION)
            kind = request.url.params.get("kind")
            items = [i for i in self.items.get(task, []) if (task, i["sha256"]) not in self.results
                     and (task, i["sha256"]) not in self.running
                     and (kind is None or (i["kind"] == "video") == (kind == "video"))]
            return httpx.Response(200, json={"version": version, "items": items[:int(request.url.params["limit"])]})
        if path == "claim":
            key = (body["task"], body["sha256"])
            if key in self.results or self.claims.get(key, 0) >= 3:
                return httpx.Response(200, json={"claimed": False})
            self.claims[key] = self.claims.get(key, 0) + 1
            self.running.add(key)
            return httpx.Response(200, json={"claimed": True})
        if path == "task-result":
            self.results[(body["task"], body["sha256"])] = body
            self.running.discard((body["task"], body["sha256"]))
            if body["task"] == "fingerprint" and "fp" in body:
                self.fingerprints[body["sha256"]] = {"sha256": body["sha256"], "duration": body["duration"], "fp": body["fp"]}
            return httpx.Response(200, json={"ok": True})
        if path.startswith("object/"):
            self.objects[path.removeprefix("object/")] = request.content
            return httpx.Response(200, json={"size": len(request.content)})
        if path.startswith("blob/"):
            return httpx.Response(200, content=self.blobs[path.removeprefix("blob/")])
        if path == "fingerprints":
            after = request.url.params.get("after", "")
            page = sorted((v for k, v in self.fingerprints.items() if k > after), key=lambda v: v["sha256"])
            limit = int(request.url.params["limit"])
            return httpx.Response(200, json={"items": page[:limit], "next": page[limit - 1]["sha256"] if len(page) > limit else None})
        if path == "matches":
            if body.get("all"):
                self.pairs = []
            self.pairs = [p for p in self.pairs if p["a"] not in body.get("shas", []) and p["b"] not in body.get("shas", [])]
            self.pairs += body["pairs"]
            return httpx.Response(200, json={"saved": len(body["pairs"])})
        return httpx.Response(404, json={"error": path})


@needs_ffmpeg
def test_preview_clips_are_cut_faded_and_reported(tmp_path):
    from ra.processing import Inputs, run_clips

    src = write_wav(tmp_path / "song.wav", music(20, seed=7))
    item = {"sha256": sha(src), "name": "song.wav", "ext": "wav", "kind": "audio", "lossless": True,
            "format": {"codec": "pcm_s16le", "bits": 16, "rate": 44100, "channels": 2, "duration": 20},
            "spans": [{"from_ms": 5000, "to_ms": 15000}], "spec": "5000-15000"}
    site = QueueSite({"clip": [item]})
    site.blobs = {sha(src): src.read_bytes()}
    counts = run_clips(site.client(), Inputs(site.client(), tmp_path / "tmp"), workers=1, log=lambda m: None)
    assert counts.done == 1
    report = site.results[("clip", sha(src))]["clips"]
    assert sorted(c["kind"] for c in report) == ["lossless", "lossy"]
    for c in report:
        assert (c["from_ms"], c["to_ms"]) == (5000, 15000)
        assert c["key"].startswith(f"derived/clip/{sha(src)}/5000-15000.") and c["key"] in site.objects
        assert c["size"] == len(site.objects[c["key"]])
    flac = tmp_path / "clip.flac"
    flac.write_bytes(site.objects[next(c["key"] for c in report if c["kind"] == "lossless")])
    pcm = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(flac), "-f", "s16le", "-ac", "1", "pipe:1"],
                                       capture_output=True, check=True).stdout, dtype="<i2").astype(float)
    assert abs(len(pcm) / 44100 - 10) < 0.05  # ten seconds
    level = lambda a: float(np.sqrt(np.mean(a ** 2)))  # noqa: E731
    middle = level(pcm[4 * 44100:6 * 44100])
    assert level(pcm[:441]) < middle * 0.2  # faded in (it starts inside the track)
    assert level(pcm[-2205:]) < middle * 0.2  # faded out


def test_derive_queue_claims_stores_and_reports(tmp_path):
    from PIL import Image

    from ra.processing import Inputs, run_derive

    good = tmp_path / "good.png"
    Image.new("RGB", (800, 600), (1, 2, 3)).save(good)
    bad = b"not an image at all"
    items = [
        {"sha256": sha(good), "name": "good.png", "ext": "png", "kind": "image", "format": {}},
        {"sha256": hashlib.sha256(bad).hexdigest(), "name": "bad.png", "ext": "png", "kind": "image", "format": {}},
    ]
    site = QueueSite({"derive": items})
    site.blobs = {sha(good): good.read_bytes(), items[1]["sha256"]: bad}
    counts = run_derive(site.client(), Inputs(site.client(), tmp_path / "tmp"), workers=2, log=lambda m: None)
    assert counts.done == 1 and counts.failed == 1
    report = site.results[("derive", sha(good))]
    assert sorted(o["kind"] for o in report["outputs"]) == ["img1600", "img240", "img640"] or \
        sorted(o["kind"] for o in report["outputs"]) == ["img240", "img640"]
    assert all(o["key"] in site.objects for o in report["outputs"])
    assert "图片无法读取" in site.results[("derive", items[1]["sha256"])]["error"]
    assert not any((tmp_path / "tmp").iterdir())  # scratch space emptied


@needs_ffmpeg
def test_fingerprint_queue_and_matching(tmp_path):
    from ra.processing import Inputs, run_fingerprint, run_matching

    a = write_wav(tmp_path / "a.wav", music(40, 3))
    b = tmp_path / "b.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(a), "-b:a", "160k", str(b)], check=True)
    c = write_wav(tmp_path / "c.wav", music(40, 4))
    local = {sha(p): p for p in (a, b, c)}
    items = [{"sha256": s, "name": p.name, "ext": p.suffix[1:], "kind": "audio", "format": {}} for s, p in local.items()]
    site = QueueSite({"fingerprint": items})
    client = site.client()
    counts, new = run_fingerprint(client, Inputs(client, tmp_path / "tmp", local.get), workers=2, log=lambda m: None)
    assert counts.done == 3 and sorted(new) == sorted(local)
    assert run_matching(client, new, log=lambda m: None) == 1
    pair = site.pairs[0]
    assert {pair["a"], pair["b"]} == {sha(a), sha(b)} and pair["a"] < pair["b"]


# ---------------------------------------------------------------- backup


class DumpSite:
    """A real HTTP server with the endpoints the backup uses (rclone reads originals over HTTP)."""

    def __init__(self, db: sqlite3.Connection, blobs: dict[str, bytes]):
        self.db, self.blobs, self.runs = db, blobs, []
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, data, code=200):
                raw = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _blob(self, body: bool):
                name = self.path.rsplit("/", 1)[1]
                data = site.blobs.get(name)
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                if body:
                    self.wfile.write(data)

            def do_HEAD(self):
                self._blob(False)

            def do_GET(self):
                from urllib.parse import parse_qs, urlsplit

                url = urlsplit(self.path)
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                if url.path.startswith("/admin/api/worker/blob/"):
                    return self._blob(True)
                if url.path == "/admin/api/worker/objects":
                    return self._json({"objects": [{"key": f"blobs/{k}", "size": len(v)} for k, v in sorted(site.blobs.items())],
                                       "cursor": None})
                if url.path == "/admin/api/worker/dump" and "table" not in q:
                    rows = site.db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").fetchall()
                    tables = [{"name": n, "sql": s, "rows": 0} for t, n, _, s in rows if t == "table"]
                    indexes = [{"name": n, "table": tb, "sql": s} for t, n, tb, s in rows if t == "index"]
                    return self._json({"tables": tables, "indexes": indexes})
                if url.path == "/admin/api/worker/dump":
                    cur = site.db.execute(f'SELECT rowid AS _rowid_, * FROM "{q["table"]}" WHERE rowid > ? ORDER BY rowid LIMIT ?',
                                          (int(q.get("after", 0)), int(q.get("limit", 500))))
                    rows = cur.fetchall()
                    limit = int(q.get("limit", 500))
                    return self._json({"columns": [d[0] for d in cur.description][1:], "rows": [list(r[1:]) for r in rows],
                                       "last": rows[-1][0] if len(rows) == limit else None})
                self._json({"error": url.path}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if body["action"] == "start":
                    site.runs.append({})
                    return self._json({"id": len(site.runs)})
                site.runs[body["id"] - 1] = body
                return self._json({"ok": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()


def sample_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.executescript("""
      CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER, note TEXT);
      CREATE INDEX files_name ON files (name);
      CREATE TABLE revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT);
    """)
    db.executemany("INSERT INTO files VALUES (?, ?, ?, ?)",
                   [(f"f_{i}", f"曲 {i}'s \"name\"", i * 10, None if i % 2 else "备注\n两行") for i in range(1203)])
    db.executemany("INSERT INTO revisions (summary) VALUES (?)", [(json.dumps({"k": "撤销：{what}"}),)] * 7)
    db.execute("CREATE TABLE fingerprints (sha256 TEXT PRIMARY KEY, fp TEXT)")
    db.execute("INSERT INTO fingerprints VALUES (?, ?)", ("a" * 64, "x" * 200_000))
    return db


def test_database_export_restores_to_the_same_rows(tmp_path):
    from ra.backup import export_database
    from ra.site import SiteClient

    db = sample_db()
    site = DumpSite(db, {})
    try:
        out = tmp_path / "db.sql.gz"
        counts = export_database(SiteClient(site.base, "t"), out, log=lambda m: None)
    finally:
        site.close()
    assert counts == {"files": 1203, "revisions": 7}  # fingerprints are processing results: schema only
    restored = sqlite3.connect(":memory:")
    restored.executescript(gzip.decompress(out.read_bytes()).decode())
    assert restored.execute("SELECT * FROM files ORDER BY id").fetchall() == db.execute("SELECT * FROM files ORDER BY id").fetchall()
    assert restored.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").fetchall() == [("files_name",)]
    assert restored.execute("SELECT seq FROM sqlite_sequence WHERE name = 'revisions'").fetchone() == (7,)


@needs_rclone
def test_backup_copies_new_originals_encrypted_and_verifies(tmp_path, monkeypatch):
    from ra import backup
    from ra.site import SiteClient

    blobs = {hashlib.sha256(d).hexdigest(): d for d in (b"first original", b"second" * 1000, bytes(range(256)) * 300)}
    site = DumpSite(sample_db(), dict(blobs))
    vault = tmp_path / "bucket"
    real_env = backup.rclone_env

    def local_env(conf):  # the B2 remote replaced by a local folder; crypt stays as in production
        env = real_env(conf)
        env.update({"RCLONE_CONFIG_B2_TYPE": "local", "RCLONE_CONFIG_VAULT_REMOTE": f"{vault}/{backup.FOLDER}"})
        return env

    monkeypatch.setattr(backup, "rclone_env", local_env)
    env_file = tmp_path / "backup.env"
    env_file.write_text("B2_KEY_ID=k\nB2_APP_KEY=s\nB2_BUCKET=b\nBACKUP_CRYPT_PASSWORD=pw1\nBACKUP_CRYPT_SALT=pw2\n")
    for key in backup.SETTINGS:
        monkeypatch.delenv(key, raising=False)
    try:
        client = SiteClient(site.base, "t")
        report = backup.run(client, env_file, tmp_path, log=lambda m: None)
        assert report["blobs"]["copied"] == 3 and report["blobs"]["backed_up"] == 3 and report["verified"] == 3
        stored = [p for p in vault.rglob("*") if p.is_file()]
        assert len(stored) == 4  # three originals and one database export
        names = " ".join(str(p.relative_to(vault)) for p in stored)
        assert not any(s[:12] in names for s in blobs) and "blobs" not in names  # names encrypted too
        assert all(b"first original" not in p.read_bytes() for p in stored)  # contents encrypted

        site.blobs[hashlib.sha256(b"third").hexdigest()] = b"third"
        report = backup.run(client, env_file, tmp_path, log=lambda m: None)
        assert report["blobs"]["copied"] == 1 and report["blobs"]["backed_up"] == 4  # only the new one
        assert site.runs[-1]["ok"] is True
    finally:
        site.close()


def test_backup_without_settings_names_what_is_missing(tmp_path, monkeypatch):
    from ra import backup

    for key in backup.SETTINGS:
        monkeypatch.delenv(key, raising=False)
    env_file = tmp_path / "backup.env"
    env_file.write_text("B2_KEY_ID=\nB2_BUCKET=b\n")
    with pytest.raises(backup.BackupError, match="B2_KEY_ID, B2_APP_KEY"):
        backup.settings(env_file)


@needs_flac
def test_deriving_audio_also_fingerprints_it_from_the_same_download(tmp_path):
    from ra.processing import Inputs, run_derive

    src = write_wav(tmp_path / "a.wav", music(40, 5))
    item = {"sha256": sha(src), "name": "a.wav", "ext": "wav", "kind": "audio",
            "format": {"codec": "pcm_s16le", "lossless": True, "bits": 16, "rate": 44100, "channels": 2, "duration": 40}}
    site = QueueSite({"derive": [item]})
    site.blobs = {sha(src): src.read_bytes()}
    counts = run_derive(site.client(), Inputs(site.client(), tmp_path / "tmp"), log=lambda m: None)
    assert counts.done == 1 and counts.fingerprinted == [sha(src)]
    assert sha(src) in site.fingerprints and ("fingerprint", sha(src)) in site.results


def test_damaged_images_keep_what_is_left_or_fail_clearly(tmp_path):
    from PIL import Image

    gradient = Image.linear_gradient("L").resize((600, 600)).convert("RGB")
    good = tmp_path / "good.png"
    gradient.save(good)
    data = good.read_bytes()
    truncated = tmp_path / "truncated.png"
    truncated.write_bytes(data[: len(data) // 2])  # the lower half of the picture is missing
    out = derive.derive(truncated, {"sha256": "a" * 64, "kind": "image"}, tmp_path / "t")
    assert out[0].info["damaged"] is True and out[0].info["width"] == 240

    idat = data.index(b"IDAT") + 4
    garbage = tmp_path / "garbage.png"
    garbage.write_bytes(data[:idat] + bytes(len(data) - idat))  # nothing of the picture left
    with pytest.raises(derive.DeriveError, match="损坏|无法读取"):
        derive.derive(garbage, {"sha256": "b" * 64, "kind": "image"}, tmp_path / "g")
    assert "damaged" not in derive.derive(good, {"sha256": "c" * 64, "kind": "image"}, tmp_path / "ok")[0].info


def test_a_bug_in_one_content_is_reported_and_the_rest_go_on(tmp_path, monkeypatch):
    from PIL import Image

    from ra import processing

    images = []
    for n in range(3):
        path = tmp_path / f"{n}.png"
        Image.new("RGB", (300, 300), (n, n, n)).save(path)
        images.append(path)
    items = [{"sha256": sha(p), "name": p.name, "ext": "png", "kind": "image", "format": {}} for p in images]
    site = QueueSite({"derive": items})
    site.blobs = {sha(p): p.read_bytes() for p in images}
    real = processing.derive_mod.derive

    def buggy(src, item, work):
        if item["name"] == "1.png":
            return {}["no such key"]  # a KeyError nobody planned for
        return real(src, item, work)

    monkeypatch.setattr(processing.derive_mod, "derive", buggy)
    counts = processing.run_derive(site.client(), processing.Inputs(site.client(), tmp_path / "tmp"), log=lambda m: None)
    assert counts.done == 2 and counts.failed == 1
    error = site.results[("derive", sha(images[1]))]["error"]
    assert error.startswith("程序错误 KeyError") and "test_processing.py" in error


def test_a_long_video_does_not_hold_up_the_rest(tmp_path, monkeypatch):
    from PIL import Image

    from ra import processing
    from ra.worker import run_cycle

    release = threading.Event()
    real = processing.derive_mod.derive

    def derive(src, item, work):
        if item["kind"] == "video":  # a live recording: transcodes until released
            assert release.wait(20)
            return []
        return real(src, item, work)

    monkeypatch.setattr(processing.derive_mod, "derive", derive)
    monkeypatch.setattr(processing.fp_mod, "compute", lambda path: np.arange(400, dtype=np.uint32))
    image = tmp_path / "cover.png"
    Image.new("RGB", (300, 300), (9, 9, 9)).save(image)
    live = hashlib.sha256(b"live").hexdigest()
    video = {"sha256": live, "name": "live.webm", "ext": "webm", "kind": "video", "format": {}}
    items = [video, {"sha256": sha(image), "name": "cover.png", "ext": "png", "kind": "image", "format": {}}]
    site = QueueSite({"derive": items, "fingerprint": [video]})  # the video comes first, as the newest would
    site.blobs = {live: b"live", sha(image): image.read_bytes()}
    client = site.client()
    inputs = processing.Inputs(client, tmp_path / "tmp")
    finished = threading.Event()
    lane = processing.VideoLane(client, inputs, log=lambda m: None, on_done=finished.set)
    tasks = ("derive", "fingerprint")

    counts = run_cycle(client, inputs, None, None, tasks, log=lambda m: None, video_lane=lane)
    assert counts.done == 1 and ("derive", sha(image)) in site.results  # done while the video goes on
    assert lane.busy and lane.status()["name"] == "live.webm" and ("derive", live) not in site.results
    assert ("fingerprint", live) not in site.claims  # left to the lane, which has the video downloaded
    assert run_cycle(client, inputs, None, None, tasks, log=lambda m: None, video_lane=lane).done == 0
    assert site.claims[("derive", live)] == 1  # not taken twice

    release.set()
    assert finished.wait(20)
    lane.wait(20)
    counts = run_cycle(client, inputs, None, None, tasks, log=lambda m: None, video_lane=lane)
    assert counts.done == 1 and counts.fingerprinted == [live] and not lane.busy and lane.status() is None
    assert site.results[("derive", live)]["outputs"] == [] and "fp" in site.results[("fingerprint", live)]
    assert site.claims[("fingerprint", live)] == 1
    assert lane.collect().done == 0  # collected once


def test_a_run_ends_when_everything_is_taken_by_another_worker(tmp_path, monkeypatch):
    from ra import processing

    monkeypatch.setattr(processing.time, "sleep", lambda s: None)
    items = [{"sha256": "a" * 64, "name": "x.png", "ext": "png", "kind": "image", "format": {}}]
    site = QueueSite({"derive": items, "fingerprint": items})
    site.claims = {("derive", "a" * 64): 3, ("fingerprint", "a" * 64): 3}  # the site refuses every claim
    client = site.client()
    counts = processing.run_derive(client, processing.Inputs(client, tmp_path), log=lambda m: None)
    assert counts.done == 0 and counts.skipped == processing.IDLE_PAGES
    counts, new = processing.run_fingerprint(client, processing.Inputs(client, tmp_path), log=lambda m: None)
    assert new == [] and counts.skipped == processing.IDLE_PAGES
