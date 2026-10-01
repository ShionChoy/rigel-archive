"""Files for playing and previewing, made from the originals (`uv run ra derive`; in the cloud the
processing container runs the same code).

  audio  lossless  stream FLAC (bit-exact: its PCM MD5 must equal the original's; seek table every
                   10 s; no embedded pictures, which only slow down the start) + AAC 256 kbps + waveform
         lossy     MP3 and AAC stream as they are; other codecs (Vorbis, TwinVQ, WMA …) get an AAC
                   copy so every browser can play them; waveform
  image  WebP at 240 / 640 / 1600 px, only sizes smaller than the original
  video  MP4 with H.264 + AAC, at most 1080p: remuxed when the video already is browser-friendly
         H.264, otherwise transcoded; plus a poster frame (WebP)

Outputs go to storage under derived/, named after the original's SHA-256 (see DERIVED_KEY in
site/src/lib/blobs.ts), and can always be made again. A FLAC that is already fine for streaming (seek
table, small pictures, nothing in front of the stream) is used as it is, and contents with the same
decoded audio (pcm_md5, e.g. a WAV and its FLAC) share one set of stream files.
"""

import json
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .probe import LOSSLESS_CODECS, ffprobe, flac_md5

# site/src/lib/processing.ts has the same number. 2: pictures of 12 MB or more also get «embed» (the site
# asks version 1 contents again only when they are such pictures, see EMBED_SQL there).
DERIVE_VERSION = 2
EMBED_MIN_BYTES = 12_000_000  # pictures this large are embedded into downloads as their 1600 px JPEG copy
EMBED_SIZE = 1600

IMAGE_SIZES = (240, 640, 1600)
WEBP_QUALITY = 80
AAC_KBPS_LOSSLESS = 256
AAC_KBPS_LOSSY = 192
WAVE_POINTS = 1000
WAVE_RATE = 2000  # samples per second decoded for the waveform
PICTURE_LIMIT = 512 * 1024  # embedded pictures above this make an original FLAC slow to start
SEEK_EVERY = "10s"
MAX_VIDEO_HEIGHT = 1080
BROWSER_AUDIO = {"mp3", "aac"}  # lossy codecs every browser plays, streamed from the original
BROWSER_PIX_FMTS = {"yuv420p", "yuvj420p"}
X264 = ["-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p", "-profile:v", "high"]
LONG_VIDEO_SECONDS = 1800  # live recordings: a faster preset (slightly larger file) keeps them to about realtime
TIMEOUT = 6 * 3600  # a long live video transcodes for a while; anything longer is stuck


class DeriveError(Exception):
    """This content cannot be made into what the site needs (the message says why, in Chinese)."""


@dataclass
class Output:
    kind: str  # stream | aac | wave | img240 | img640 | img1600 | embed | video | poster
    key: str  # where it is stored
    size: int
    content_type: str
    info: dict = field(default_factory=dict)
    path: Path | None = None  # local file to store; None when it is stored already

    def report(self) -> dict:
        return {"kind": self.kind, "key": self.key, "size": self.size, "info": self.info}


def _run(args: list[str], timeout: float = TIMEOUT, **kwargs) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout, **kwargs)
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        why = " / ".join(tail)[:300] or f"退出码 {result.returncode}"  # killed (e.g. the container stopping)
        raise DeriveError(f"{Path(args[0]).name} 失败：{why}")
    return result


def _ffmpeg(*args: str, timeout: float = TIMEOUT) -> subprocess.CompletedProcess:
    return _run(["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", *args], timeout=timeout)


def _output(kind: str, key: str, path: Path, content_type: str, info: dict) -> Output:
    return Output(kind, key, path.stat().st_size, content_type, info, path)


# ------------------------------------------------------------------ audio


@dataclass
class FlacLayout:
    """What an original FLAC carries besides the audio."""

    id3: bool  # an ID3 tag in front of the stream (some browsers refuse such files)
    seektable: bool
    pictures: int  # bytes of embedded pictures
    bits: int
    rate: int
    channels: int


def flac_layout(path: Path) -> FlacLayout | None:
    with path.open("rb") as fh:
        head = fh.read(10)
        start = 0
        if head[:3] == b"ID3":
            size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]
            start = 10 + size + (10 if head[5] & 0x10 else 0)
        fh.seek(start)
        if fh.read(4) != b"fLaC":
            return None
        seektable, pictures, info = False, 0, None
        while True:
            header = fh.read(4)
            if len(header) < 4:
                return None
            last, kind, size = header[0] & 0x80, header[0] & 0x7F, int.from_bytes(header[1:4], "big")
            if kind == 0:
                block = fh.read(size)
                packed = int.from_bytes(block[10:18], "big")
                rate = packed >> 44
                channels = ((packed >> 41) & 0x7) + 1
                bits = ((packed >> 36) & 0x1F) + 1
                info = (bits, rate, channels)
            else:
                seektable |= kind == 3 and size > 0
                pictures += size if kind == 6 else 0
                fh.seek(size, 1)
            if last:
                break
    if info is None:
        return None
    return FlacLayout(start > 0, seektable, pictures, *info)


def _lossless(fmt: dict) -> bool:
    codec = fmt.get("codec") or ""
    return bool(fmt.get("lossless")) or codec in LOSSLESS_CODECS or codec.startswith("pcm_")


def stream_flac(src: Path, sha256: str, fmt: dict, pcm_md5: str | None, work: Path) -> Output | None:
    """The lossless stream: the original when it is a clean FLAC, else a bit-exact FLAC encode."""
    codec = fmt.get("codec") or ""
    if codec.startswith("pcm_f"):
        return None  # floating-point PCM has no exact FLAC form; the AAC copy plays instead
    layout = flac_layout(src) if codec == "flac" else None
    if layout and not layout.id3 and layout.seektable and layout.pictures <= PICTURE_LIMIT and layout.bits <= 24:
        info = {"codec": "flac", "bits": layout.bits, "rate": layout.rate, "channels": layout.channels, "original": True}
        return Output("stream", f"blobs/{sha256}", src.stat().st_size, "audio/flac", info)

    bits = int(fmt.get("bits") or (layout.bits if layout else 16))
    if bits > 24:
        return None  # 32-bit integer audio: the AAC copy plays instead
    # 8-bit WAVs become 16-bit FLAC (every value kept); 17–24-bit audio stays 24-bit.
    depth = ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"] if bits > 16 else ["-sample_fmt", "s16"]
    out = work / f"{sha256}.flac"
    _ffmpeg("-i", str(src), "-map", "0:a:0", "-map_metadata", "0", "-c:a", "flac", "-compression_level", "8",
            *depth, str(out))
    _run(["metaflac", "--remove", "--block-type=PICTURE,PADDING", "--dont-use-padding", str(out)])
    _run(["metaflac", f"--add-seekpoint={SEEK_EVERY}", str(out)])
    made = flac_layout(out)
    if made is None or not made.seektable:
        raise DeriveError("生成的 FLAC 没有定位表")
    # Every sample must survive: the encoder's MD5 of the decoded audio equals the original's.
    if pcm_md5 and bits in (16, 24) and flac_md5(out) != pcm_md5:
        raise DeriveError("推流 FLAC 与原件的 PCM MD5 不一致，没有保存")
    info = {"codec": "flac", "bits": made.bits, "rate": made.rate, "channels": made.channels}
    return _output("stream", f"derived/stream/{sha256}.flac", out, "audio/flac", info)


def aac_copy(src: Path, sha256: str, fmt: dict, work: Path) -> Output:
    kbps = AAC_KBPS_LOSSLESS if _lossless(fmt) else AAC_KBPS_LOSSY
    rate = int(fmt.get("rate") or 44100)
    out = work / f"{sha256}.m4a"
    args = ["-i", str(src), "-map", "0:a:0", "-map_metadata", "0", "-c:a", "aac", "-b:a", f"{kbps}k"]
    if rate > 48000 or rate < 8000:
        args += ["-ar", "48000"]
    if int(fmt.get("channels") or 2) > 2:
        args += ["-ac", "2"]
    _ffmpeg(*args, "-movflags", "+faststart", str(out))
    info = {"codec": "aac", "kbps": kbps, "rate": 48000 if rate > 48000 or rate < 8000 else rate}
    return _output("aac", f"derived/stream/{sha256}.m4a", out, "audio/mp4", info)


def waveform(src: Path, sha256: str, duration: float, work: Path) -> Output:
    """Peak level (0–255) in WAVE_POINTS equal slices of the track, for the player's seek bar."""
    import numpy as np

    raw = _ffmpeg("-i", str(src), "-map", "0:a:0", "-ac", "1", "-ar", str(WAVE_RATE), "-f", "s16le", "pipe:1").stdout
    samples = np.abs(np.frombuffer(raw, dtype="<i2").astype(np.int32))
    if samples.size == 0:
        raise DeriveError("解码后没有音频")
    points = min(WAVE_POINTS, samples.size)
    edges = np.linspace(0, samples.size, points + 1).astype(np.int64)
    peaks = np.maximum.reduceat(samples, edges[:-1])
    levels = np.minimum(255, np.round(peaks / 32768 * 255)).astype(int).tolist()
    out = work / f"{sha256}.wave.json"
    out.write_text(json.dumps({"duration": round(duration or samples.size / WAVE_RATE, 3), "peaks": levels},
                              separators=(",", ":")))
    return _output("wave", f"derived/wave/{sha256}.json", out, "application/json", {"points": points})


def derive_audio(src: Path, sha256: str, fmt: dict, pcm_md5: str | None, work: Path) -> list[Output]:
    codec = fmt.get("codec") or ""
    outputs: list[Output] = []
    if _lossless(fmt):
        stream = stream_flac(src, sha256, fmt, pcm_md5, work)
        if stream:
            outputs.append(stream)
    if codec not in BROWSER_AUDIO:
        outputs.append(aac_copy(src, sha256, fmt, work))
    outputs.append(waveform(src, sha256, float(fmt.get("duration") or 0), work))
    return outputs


# ------------------------------------------------------------------ images


_PILLOW = threading.Lock()  # guards Pillow's global LOAD_TRUNCATED_IMAGES switch below


def _open_image(src: Path):
    """(the first frame as RGB(A), whether the file is damaged). A damaged file (common in old web and
    game folders) is read again leniently, which recovers what is left of the picture; when that is one
    flat colour, nothing is left."""
    from PIL import Image, ImageFile, ImageOps

    Image.MAX_IMAGE_PIXELS = 400_000_000  # scans of whole booklet spreads reach ~70 megapixels

    def load(lenient: bool):
        ImageFile.LOAD_TRUNCATED_IMAGES = lenient
        try:
            image = Image.open(src)
            image.seek(0)  # first frame of an animation
            image.load()
            return image
        finally:
            ImageFile.LOAD_TRUNCATED_IMAGES = False

    damaged = False
    with _PILLOW:
        try:
            image = load(False)
        except Exception as exc:  # Pillow raises many kinds for unreadable files
            damaged = True
            try:
                image = load(True)
            except Exception:
                raise DeriveError(f"图片无法读取：{exc}") from exc
            bands = image.getextrema()
            flat = all(lo == hi for lo, hi in (bands if isinstance(bands[0], tuple) else [bands]))
            if flat:
                raise DeriveError(f"图片数据损坏，解不出画面（{exc}）") from exc
    image = ImageOps.exif_transpose(image)
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    return image.convert("RGBA" if has_alpha else "RGB"), damaged


def derive_image(src: Path, sha256: str, work: Path) -> list[Output]:
    """WebP copies whose longer side is each of IMAGE_SIZES, never enlarged: a size is made only when
    the original is larger, except the smallest, which every image gets (as its thumbnail)."""
    from PIL import Image

    image, damaged = _open_image(src)
    longest = max(image.size)
    outputs = []
    for size in IMAGE_SIZES:
        if longest <= size and size != IMAGE_SIZES[0]:
            break
        copy = image.copy()
        copy.thumbnail((size, size), Image.Resampling.LANCZOS)
        out = work / f"img{size}.webp"
        copy.save(out, "WEBP", quality=WEBP_QUALITY, method=5)
        info = {"width": copy.width, "height": copy.height, **({"damaged": True} if damaged else {})}
        outputs.append(_output(f"img{size}", f"derived/img/{sha256}/{size}.webp", out, "image/webp", info))
    if src.stat().st_size >= EMBED_MIN_BYTES:
        # A JPEG a download can embed as the cover (a whole-booklet scan is too large to embed as it is).
        copy = image.convert("RGB")
        copy.thumbnail((EMBED_SIZE, EMBED_SIZE), Image.Resampling.LANCZOS)
        out = work / "embed.jpg"
        copy.save(out, "JPEG", quality=90, optimize=True)
        outputs.append(_output("embed", f"derived/img/{sha256}/embed.jpg", out, "image/jpeg", {"width": copy.width, "height": copy.height}))
    return outputs


# ------------------------------------------------------------------ video


def _streams(data: dict, kind: str) -> list[dict]:
    return [s for s in data.get("streams", []) if s.get("codec_type") == kind
            and not s.get("disposition", {}).get("attached_pic")]


def derive_video(src: Path, sha256: str, work: Path) -> list[Output]:
    data = ffprobe(src)
    videos, audios = _streams(data, "video"), _streams(data, "audio")
    if not videos:
        raise DeriveError("没有视频画面")
    video = videos[0]
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    interlaced = (video.get("field_order") or "progressive") not in ("progressive", "unknown")
    copy_video = (
        video.get("codec_name") == "h264" and video.get("pix_fmt") in BROWSER_PIX_FMTS
        and height <= MAX_VIDEO_HEIGHT and not interlaced
    )
    args = ["-i", str(src), "-map", "0:v:0", "-map_metadata", "-1", "-sn", "-dn"]
    if copy_video:
        args += ["-c:v", "copy"]
        out_height = height
    else:
        filters = ["yadif"] if interlaced else []
        if height > MAX_VIDEO_HEIGHT:
            filters.append(f"scale=-2:{MAX_VIDEO_HEIGHT}")
            out_height = MAX_VIDEO_HEIGHT
        else:
            filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")  # H.264 needs even sizes
            out_height = height - height % 2
        preset = "veryfast" if duration > LONG_VIDEO_SECONDS else "fast"
        args += ["-vf", ",".join(filters), *X264, "-preset", preset]
    if audios:
        args += ["-map", "0:a:0"]
        if audios[0].get("codec_name") == "aac":
            args += ["-c:a", "copy"]
        else:
            args += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    out = work / f"{sha256}.mp4"
    _ffmpeg(*args, "-movflags", "+faststart", str(out))

    made = ffprobe(out)
    made_video = _streams(made, "video")[0]
    made_duration = float(made.get("format", {}).get("duration") or 0)
    if duration and abs(made_duration - duration) > max(2.0, duration * 0.01):
        raise DeriveError(f"转出的视频时长 {made_duration:.1f} 秒与原件 {duration:.1f} 秒不符")
    info = {"vcodec": "h264", "acodec": "aac" if audios else None, "width": made_video.get("width"),
            "height": made_video.get("height"), "duration": round(made_duration, 3), "remuxed": copy_video}
    outputs = [_output("video", f"derived/video/{sha256}/{out_height}p.mp4", out, "video/mp4",
                       {k: v for k, v in info.items() if v is not None})]

    outputs.append(poster(out, sha256, duration, work))
    return outputs


def poster(video: Path, sha256: str, duration: float, work: Path) -> Output:
    """A frame a little way in (openings are often black), as WebP at most 1600 px wide."""
    from PIL import Image

    at = min(duration * 0.1, 30.0) if duration else 0
    frame = work / "poster.png"
    _ffmpeg("-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", "-update", "1", str(frame))
    if not frame.exists():
        raise DeriveError("取不到视频画面")
    image, _ = _open_image(frame)
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    out = work / "poster.webp"
    image.save(out, "WEBP", quality=WEBP_QUALITY, method=5)
    return _output("poster", f"derived/video/{sha256}/poster.webp", out, "image/webp",
                   {"width": image.width, "height": image.height})


# ------------------------------------------------------------------ entry


# ------------------------------------------------------------------ preview clips

# site/src/lib/processing.ts TASK_VERSIONS.clip has the same number.
CLIP_VERSION = 1
CLIP_FADE_IN = 0.5  # seconds, when a clip does not start at the beginning of the track
CLIP_FADE_OUT = 3.0


@dataclass
class ClipOutput:
    """One preview clip as stored: a part of the track (milliseconds) in one version."""
    from_ms: int
    to_ms: int
    out: Output

    def report(self) -> dict:
        return {"from_ms": self.from_ms, "to_ms": self.to_ms, **self.out.report()}


def clips(src: Path, sha256: str, spans: list[dict], fmt: dict, lossless: bool, work: Path) -> list[ClipOutput]:
    """Preview clips (设计文档「文件权限方案 · 试听片段」): each wanted part of the track as FLAC (lossless sources
    only) and AAC 256 kbps, faded in when it starts inside the track and out over its last seconds. The site
    plays only these for a track set to 「仅试听」, never the whole track."""
    work.mkdir(parents=True, exist_ok=True)
    bits = int(fmt.get("bits") or 16)
    out: list[ClipOutput] = []
    for span in spans:
        start_ms, end_ms = int(span["from_ms"]), int(span["to_ms"])
        if end_ms <= start_ms:
            raise DeriveError("试听范围无效")
        start, length = start_ms / 1000, (end_ms - start_ms) / 1000
        fades = ([f"afade=t=in:st=0:d={CLIP_FADE_IN}"] if start_ms > 0 else []) + \
                ([f"afade=t=out:st={length - CLIP_FADE_OUT:.3f}:d={CLIP_FADE_OUT}"] if length > 2 * CLIP_FADE_OUT else [])
        # -ss before -i seeks fast; with re-encoding ffmpeg still starts at the exact sample.
        base = ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src), "-map", "0:a:0", "-map_metadata", "-1",
                *(["-af", ",".join(fades)] if fades else [])]
        name = f"{start_ms}-{end_ms}"
        rate = int(fmt.get("rate") or 44100)
        if lossless:
            path = work / f"{name}.flac"
            depth = ["-sample_fmt", "s32", "-bits_per_raw_sample", "24"] if bits > 16 else ["-sample_fmt", "s16"]
            _ffmpeg(*base, "-c:a", "flac", "-compression_level", "8", *depth, str(path))
            made = flac_layout(path)
            info = {"codec": "flac", "bits": made.bits if made else min(bits, 24), "rate": made.rate if made else rate}
            out.append(ClipOutput(start_ms, end_ms, _output("lossless", f"derived/clip/{sha256}/{name}.flac", path, "audio/flac", info)))
        path = work / f"{name}.m4a"
        args = [*base, "-c:a", "aac", "-b:a", f"{AAC_KBPS_LOSSLESS}k"]
        if rate > 48000 or rate < 8000:
            args += ["-ar", "48000"]
        if int(fmt.get("channels") or 2) > 2:
            args += ["-ac", "2"]
        _ffmpeg(*args, "-movflags", "+faststart", str(path))
        info = {"codec": "aac", "kbps": AAC_KBPS_LOSSLESS, "rate": 48000 if rate > 48000 or rate < 8000 else rate}
        out.append(ClipOutput(start_ms, end_ms, _output("lossy", f"derived/clip/{sha256}/{name}.m4a", path, "audio/mp4", info)))
    return out


def derive(src: Path, item: dict, work: Path) -> list[Output]:
    """Make the derived files for one content. ``item`` comes from the site's task list."""
    work.mkdir(parents=True, exist_ok=True)
    fmt = item.get("format") or {}
    kind = item["kind"]
    if kind == "audio":
        return derive_audio(src, item["sha256"], fmt, item.get("pcm_md5"), work)
    if kind == "image":
        return derive_image(src, item["sha256"], work)
    if kind == "video":
        return derive_video(src, item["sha256"], work)
    raise DeriveError(f"不处理的类型：{kind}")


def shared_outputs(item: dict) -> list[Output] | None:
    """Stream files of another content with the same decoded audio, when all of them exist."""
    shared = item.get("shared") or {}
    if item["kind"] != "audio" or not shared:
        return None
    fmt = item.get("format") or {}
    needed = {"wave"} | ({"stream"} if _lossless(fmt) and not (fmt.get("codec") or "").startswith("pcm_f") else set())
    needed |= {"aac"} if (fmt.get("codec") or "") not in BROWSER_AUDIO else set()
    if not needed <= set(shared):
        return None
    return [Output(kind, shared[kind]["key"], shared[kind]["size"], "", shared[kind].get("info") or {})
            for kind in sorted(needed)]


def tools_missing() -> list[str]:
    return [tool for tool in ("ffmpeg", "ffprobe", "metaflac") if shutil.which(tool) is None]

