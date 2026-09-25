"""Read media specs with ffprobe and PCM MD5s of lossless audio (`uv run ra probe`).

Results go to manifest/probe.jsonl, one object per distinct content (SHA-256): the `format` JSON the
admin shows (codec, bit depth, sample rate, duration, resolution, embedded tags) and `pcm_md5`, the MD5
of the decoded samples. FLAC stores it in its header. For 16/24/32-bit PCM WAV it is the MD5 of the
data chunk, which is exactly what a FLAC encoder would store, so a WAV and its FLAC encode (or two
FLACs that differ only in tags) share one pcm_md5.
"""

import hashlib
import json
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from .model import kind_for
from .survey import SurveyFile

PROBE_VERSION = 1
PROBE_KINDS = {"audio", "video", "image"}
LOSSLESS_CODECS = {"flac", "alac", "wavpack", "ape", "tta", "mlp", "truehd", "tak"}
TAG_KEYS = ("title", "artist", "album", "album_artist", "track", "disc", "date", "genre")
READ_SIZE = 4 * 1024 * 1024


def load_probes(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    probes = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                item = json.loads(line)
                probes[item["sha256"]] = item
    return probes


def write_probes(path: Path, probes: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for sha in sorted(probes):
            fh.write(json.dumps(probes[sha], ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


# ------------------------------------------------------------------ ffprobe


def ffprobe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", "--",
         str(path)],
        capture_output=True, stdin=subprocess.DEVNULL, timeout=120,
    )
    data = json.loads(result.stdout or b"{}")
    if result.returncode != 0 or not data.get("streams"):
        raise ValueError(result.stderr.decode("utf-8", "replace").strip()[:300] or "ffprobe found no streams")
    return data


def _num(value, cast=int):
    try:
        return cast(value)
    except (TypeError, ValueError):
        return None


def _fps(rate: str | None) -> float | None:
    if not rate or "/" not in rate:
        return None
    num, den = (_num(x) for x in rate.split("/", 1))
    return round(num / den, 3) if num and den else None


def _tags(*sources: dict) -> dict:
    tags = {}
    for source in sources:
        for key, value in (source or {}).items():
            key = key.lower()
            if key in TAG_KEYS and key not in tags and str(value).strip():
                tags[key] = str(value).strip()[:200]
    return tags


def summarize(kind: str, data: dict) -> dict:
    """The parts of ffprobe's answer the admin shows; see FileFormat in site/src/lib/db.ts."""
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    pictures = [s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic")]
    video = next((s for s in streams if s.get("codec_type") == "video" and s not in pictures), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out: dict = {}

    if kind == "image":
        image = video or streams[0]
        out.update(codec=image.get("codec_name"), width=image.get("width"), height=image.get("height"))
        return {k: v for k, v in out.items() if v is not None}

    if kind == "video" and video:
        out.update(
            container=(fmt.get("format_name") or "").split(",")[0] or None,
            vcodec=video.get("codec_name"),
            width=video.get("width"),
            height=video.get("height"),
            fps=_fps(video.get("avg_frame_rate")) or _fps(video.get("r_frame_rate")),
        )
    if audio:
        codec = audio.get("codec_name") or ""
        lossless = codec in LOSSLESS_CODECS or codec.startswith("pcm_")
        out["codec" if kind == "audio" else "acodec"] = codec or None
        out.update(rate=_num(audio.get("sample_rate")) or None, channels=audio.get("channels") or None)
        if lossless:
            out["lossless"] = True
            out["bits"] = _num(audio.get("bits_per_raw_sample")) or _num(audio.get("bits_per_sample")) or None
    duration = _num(fmt.get("duration"), float)
    if duration:
        out["duration"] = round(duration, 3)
    bitrate = _num(fmt.get("bit_rate"))
    if bitrate:
        out["kbps"] = round(bitrate / 1000)
    if pictures and kind == "audio":
        out["cover"] = True
    tags = _tags(fmt.get("tags"), audio.get("tags") if audio else None)
    if tags:
        out["tags"] = tags
    return {k: v for k, v in out.items() if v is not None}


# ------------------------------------------------------------------ PCM MD5


def flac_md5(path: Path) -> str | None:
    """The MD5 of the unencoded samples from the STREAMINFO block (None if the encoder left it blank)."""
    with open(path, "rb") as fh:
        head = fh.read(10)
        if head[:3] == b"ID3":  # some taggers put an ID3v2 tag in front of the FLAC stream
            size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
            fh.seek(10 + size + (10 if head[5] & 0x10 else 0))
        else:
            fh.seek(0)
        block = fh.read(4 + 4 + 34)
    if block[:4] != b"fLaC" or block[4] & 0x7F != 0:
        return None
    digest = block[8 + 18:8 + 34]
    return digest.hex() if len(digest) == 16 and any(digest) else None


def wav_pcm_md5(path: Path) -> str | None:
    """MD5 of the data chunk of an integer PCM WAV (the same bytes FLAC hashes), else None."""
    with open(path, "rb") as fh:
        riff = fh.read(12)
        if riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
            return None
        fmt = None
        while header := fh.read(8):
            if len(header) < 8:
                return None
            chunk_id, size = header[:4], struct.unpack("<I", header[4:])[0]
            if chunk_id == b"fmt ":
                body = fh.read(size)
                tag, channels, _rate, _byte_rate, align, bits = struct.unpack("<HHIIHH", body[:16])
                if tag == 0xFFFE and len(body) >= 26:  # WAVE_FORMAT_EXTENSIBLE: sub-format GUID starts with the tag
                    tag = struct.unpack("<H", body[24:26])[0]
                fmt = (tag, channels, align, bits)
                if size % 2:
                    fh.read(1)
            elif chunk_id == b"data":
                if fmt is None:
                    return None
                tag, channels, align, bits = fmt
                if tag != 1 or bits not in (16, 24, 32) or align != channels * bits // 8:
                    return None
                md5 = hashlib.md5()
                remaining = size if size != 0xFFFFFFFF else None  # 0xFFFFFFFF: size unknown, read to the end
                while remaining is None or remaining > 0:
                    chunk = fh.read(READ_SIZE if remaining is None else min(READ_SIZE, remaining))
                    if not chunk:
                        break
                    md5.update(chunk)
                    if remaining is not None:
                        remaining -= len(chunk)
                return md5.hexdigest()
            else:
                fh.seek(size + (size % 2), 1)
    return None


def pcm_md5(path: Path, ext: str) -> str | None:
    if ext == "flac":
        return flac_md5(path)
    if ext == "wav":
        return wav_pcm_md5(path)
    return None


# ------------------------------------------------------------------ run


def apply_probes(files: list[SurveyFile], probes: dict[str, dict]) -> list[SurveyFile]:
    """Files with probe results merged into ``format`` and ``pcm_md5``."""
    out = []
    for f in files:
        probe = probes.get(f.sha256) if f.sha256 else None
        if probe:
            fmt = {**(f.format or {}), **probe.get("format", {})}
            if "error" in probe:
                fmt["probe_error"] = probe["error"]
            f = replace(f, format=fmt, pcm_md5=probe.get("pcm_md5"))
        out.append(f)
    return out



def probe_one(sha256: str, path: Path) -> dict:
    ext = path.suffix[1:].lower()
    kind = kind_for(ext)
    item: dict = {"sha256": sha256, "v": PROBE_VERSION}
    try:
        fmt = summarize(kind, ffprobe(path))
        # ffprobe trusts the extension: random bytes named .flac come back as a "FLAC" with nothing in it.
        if kind in ("audio", "video") and not (fmt.get("duration") or fmt.get("rate") or fmt.get("width")):
            raise ValueError("读不出有效的音视频内容")
        if kind == "image" and not fmt.get("width"):
            raise ValueError("读不出有效的图片内容")
        item["format"] = fmt
    except (ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        item["error"] = str(exc)[:300] or type(exc).__name__
    try:
        md5 = pcm_md5(path, ext)
    except (OSError, struct.error):
        md5 = None
    if md5:
        item["pcm_md5"] = md5
    return item


def probe_all(files: dict[str, Path], out: Path, workers: int = 8,
              log=lambda msg: print(msg, file=sys.stderr)) -> dict[str, dict]:
    """Probe every media file not probed yet. ``files`` maps SHA-256 -> a local copy."""
    probes = load_probes(out)
    todo = [
        (sha, path) for sha, path in files.items()
        if kind_for(path.suffix[1:]) in PROBE_KINDS and probes.get(sha, {}).get("v") != PROBE_VERSION
    ]
    log(f"{len(todo)} media files to probe ({len(probes)} already done)")
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for item in pool.map(lambda job: probe_one(*job), todo):
            probes[item["sha256"]] = item
            done += 1
            if done % 2000 == 0:
                write_probes(out, probes)  # progress survives an interruption
                log(f"probed {done}/{len(todo)}")
    write_probes(out, probes)
    return probes
