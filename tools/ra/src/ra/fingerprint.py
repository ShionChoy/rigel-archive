"""Acoustic fingerprints (`uv run ra fingerprint`; in the cloud the processing container runs it).

Layer 3 of duplicate detection: two files that sound like the same recording although their bytes and
decoded samples differ (a different master or encoding, an MP3 of a CD track, one track inside a
whole-album rip or a compilation, the audio of a PV).

Fingerprints are Chromaprint's (ffmpeg's chromaprint muxer, the same algorithm as fpcalc), computed
over the whole file: about 8 values per second, each 32 bits from 16 classifiers of the sound.
Matching looks for runs of values that agree at a constant time offset:

1. candidates: an index of the upper and the lower 16 bits of every value; each shared key votes for
   (file, offset), and a pair needs MIN_VOTES votes at one offset (keys that are far too common, such as
   silence, do not vote);
2. verification: at that offset, the share of equal bits in each second is smoothed over a few seconds;
   the seconds above MATCH_LEVEL form the matching part, which must be long enough (MIN_MATCH_SECONDS),
   or cover at least half of a short file with close agreement (STRICT_SCORE).

Only the new fingerprints are compared (against all of them) unless everything is matched again.
"""

import base64
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

FINGERPRINT_VERSION = 1  # site/src/lib/processing.ts has the same number
ITEM_SECONDS = 1365 / 11025  # Chromaprint: 11025 Hz, a value every 1365 samples (~0.124 s)
MIN_VOTES = 10  # votes at one offset (±1 value) that make two files worth comparing
COMMON_FACTOR = 20  # a key this many times more frequent than average does not vote
SMOOTH = 24  # values (~3 s) over which bit agreement is averaged
MATCH_LEVEL = 0.70  # smoothed share of equal bits that counts as matching (0.5 = unrelated sound)
# A matching part counts when it is long enough, or when it covers most of a short file and agrees
# closely. Shorter or looser agreement is common between unrelated dance tracks (the same beat and
# chords for twenty seconds), found by checking the matches of the whole archive by hand (2026-09-24).
MIN_MATCH_SECONDS = 30.0
MIN_SHARE_OF_SHORTER = 0.5
STRICT_SCORE = 0.85
MAX_CANDIDATES = 40  # per file, verified in order of votes


class FingerprintError(Exception):
    pass


def compute(path: Path, timeout: float = 3600) -> np.ndarray:
    """The whole file's fingerprint (uint32 values)."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "chromaprint",
         "-fp_format", "raw", "pipe:1"],
        capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout,
    )
    if result.returncode != 0:
        raise FingerprintError(result.stderr.decode("utf-8", "replace").strip()[-300:] or f"ffmpeg 退出码 {result.returncode}")
    values = np.frombuffer(result.stdout, dtype="<u4")
    if values.size < 16:
        raise FingerprintError("音频太短，算不出指纹")
    return values


def encode(values: np.ndarray) -> str:
    return base64.b64encode(values.astype("<u4").tobytes()).decode("ascii")


def decode(text: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(text), dtype="<u4")


_POPCOUNT8 = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def _agreement(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per value: the share of the 32 bits that are equal."""
    x = np.bitwise_xor(a, b).view(np.uint8).reshape(-1, 4)
    return 1.0 - _POPCOUNT8[x].sum(axis=1) / 32.0


@dataclass
class Match:
    a: str
    b: str
    score: float  # mean share of equal bits over the matching part
    offset_ms: int  # start of the matching part in b minus its start in a
    matched_ms: int

    def report(self) -> dict:
        return {"a": self.a, "b": self.b, "score": round(self.score, 4), "offset_ms": self.offset_ms,
                "matched_ms": self.matched_ms}


def verify(a: np.ndarray, b: np.ndarray, shift: int) -> tuple[float, int] | None:
    """Compare a[i] with b[i + shift]; (score, matched values) of the longest matching part, or None."""
    start_a, start_b = max(0, -shift), max(0, shift)
    n = min(a.size - start_a, b.size - start_b)
    if n < SMOOTH:
        return None
    agree = _agreement(a[start_a:start_a + n], b[start_b:start_b + n])
    smooth = np.convolve(agree, np.ones(SMOOTH) / SMOOTH, mode="same")
    good = smooth >= MATCH_LEVEL
    if not good.any():
        return None
    # the longest run of matching values
    edges = np.flatnonzero(np.diff(np.concatenate(([0], good.view(np.int8), [0]))))
    runs = edges.reshape(-1, 2)
    lengths = runs[:, 1] - runs[:, 0]
    best = int(np.argmax(lengths))
    lo, hi = runs[best]
    return float(agree[lo:hi].mean()), int(hi - lo)


def _keys(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Two index keys per value, its upper and its lower 16 bits (a match needs only one of them to be
    exact, which survives more bit errors than the whole 32 bits); returns (keys, positions)."""
    pos = np.arange(values.size, dtype=np.int64)
    hi = (values >> 16).astype(np.int64)
    lo = (values & 0xFFFF).astype(np.int64) + (1 << 16)
    return np.concatenate((hi, lo)), np.concatenate((pos, pos))


class Index:
    """Index keys of every file → (file, position), for finding candidates by voting."""

    def __init__(self, prints: dict[str, np.ndarray]):
        self.names = list(prints)
        self.number = {name: i for i, name in enumerate(self.names)}
        self.prints = prints
        keys, files, positions = [], [], []
        for number, name in enumerate(self.names):
            k, p = _keys(prints[name])
            keys.append(k)
            positions.append(p)
            files.append(np.full(k.size, number, dtype=np.int64))
        key = np.concatenate(keys) if keys else np.zeros(0, np.int64)
        file = np.concatenate(files) if files else np.zeros(0, np.int64)
        pos = np.concatenate(positions) if positions else np.zeros(0, np.int64)
        # Keys far more common than average (silence, hum, clipping) say nothing about the music.
        counts = np.bincount(key, minlength=1 << 17)
        common = counts > COMMON_FACTOR * max(key.size / (1 << 17), 1.0)
        keep = ~common[key]
        order = np.argsort(key[keep], kind="stable")
        self.common = common
        self.key, self.file, self.pos = key[keep][order], file[keep][order], pos[keep][order]
        self.span = int(max((v.size for v in prints.values()), default=0)) + 2

    def candidates(self, name: str) -> list[tuple[int, int, int]]:
        """(votes, other file number, shift) for one file, best first; shift = other's position − this one's."""
        qkey, qpos = _keys(self.prints[name])
        keep = ~self.common[qkey]
        qkey, qpos = qkey[keep], qpos[keep]
        lo = np.searchsorted(self.key, qkey, "left")
        hi = np.searchsorted(self.key, qkey, "right")
        counts = hi - lo
        total = int(counts.sum())
        if total == 0:
            return []
        # every (query value, indexed value) pair with the same key, without a Python loop
        starts = np.repeat(lo - np.concatenate(([0], np.cumsum(counts)[:-1])), counts)
        idx = starts + np.arange(total, dtype=np.int64)
        other = self.file[idx]
        shift = self.pos[idx] - np.repeat(qpos, counts)
        mask = other != self.number[name]
        other, shift = other[mask], shift[mask]
        if other.size == 0:
            return []
        width = 2 * self.span + 1
        uniq, votes = np.unique(other * width + (shift + self.span), return_counts=True)
        # neighbouring shifts vote together (encoders shift the timing by a fraction of a value)
        spread = votes.copy()
        for d in (-1, 1):
            where = np.minimum(np.searchsorted(uniq, uniq + d), uniq.size - 1)
            hit = uniq[where] == uniq + d
            spread[hit] += votes[where[hit]]
        order = np.argsort(-spread, kind="stable")
        out, seen = [], set()
        for i in order:
            if spread[i] < MIN_VOTES or len(out) >= MAX_CANDIDATES:
                break
            f, sh = int(uniq[i] // width), int(uniq[i] % width - self.span)
            if f not in seen:
                seen.add(f)
                out.append((int(spread[i]), f, sh))
        return out


def find_matches(prints: dict[str, np.ndarray], query: list[str]) -> list[Match]:
    """Matches between each file in ``query`` and every file in ``prints`` (pairs reported once, a < b)."""
    index = Index(prints)
    found: dict[tuple[str, str], Match] = {}
    for name in query:
        values = prints[name]
        for _votes, number, shift in index.candidates(name):
            other = index.names[number]
            pair = (name, other) if name < other else (other, name)
            if pair in found:
                continue
            best = None
            for s in (shift - 1, shift, shift + 1):
                result = verify(values, prints[other], s)
                if result and (best is None or result[1] > best[1][1] or
                               (result[1] == best[1][1] and result[0] > best[1][0])):
                    best = (s, result)
            if best is None:
                continue
            s, (score, length) = best
            seconds = length * ITEM_SECONDS
            shorter = min(values.size, prints[other].size) * ITEM_SECONDS
            whole_short = seconds >= MIN_SHARE_OF_SHORTER * shorter and score >= STRICT_SCORE
            if seconds < MIN_MATCH_SECONDS and not whole_short:
                continue
            offset = s if name == pair[0] else -s
            found[pair] = Match(pair[0], pair[1], score, round(offset * ITEM_SECONDS * 1000),
                                round(seconds * 1000))
    return sorted(found.values(), key=lambda m: (m.a, m.b))
