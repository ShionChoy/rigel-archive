// Lyrics as the 正在播放 view shows them (scripts/now-playing.ts): from an .lrc file next to the track's file
// (lib/sidecar.ts; decodeText reads it), else from its «lyrics» tag (the file's own, or the one the organizers
// set on its row). Two kinds:
//
//   synced   LRC: lines with [mm:ss.xx] times (several times on one line repeat it), [offset:±ms], word times
//            <mm:ss.xx> (dropped), header tags [ar:…] [ti:…] (dropped). Lines sharing a time after the first
//            are its translation, as merged LRC files carry them.
//   plain    any other text, line by line (old iTunes files end lines with \r); blank lines part the verses.
//
// Pure (no database), so tests/lyrics.test.ts runs it under node.

export interface LyricLine {
  /** When it starts in the track (seconds); null in plain lyrics. */
  t: number | null;
  /** The line; '' for a pause between sung lines (synced) or between verses (plain). */
  text: string;
  /** Lines with the same time after the first: its translations. */
  tr?: string[];
}
export interface Lyrics { synced: boolean; lines: LyricLine[] }

const TIME = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const LEADING_TIMES = /^(?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
const HEADER = /^\s*\[([a-z#]+):([^\]]*)\]\s*$/i;
const WORD_TIME = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

const seconds = (m: string, s: string) => Number(m) * 60 + Number(s.replace(':', '.'));

/** The lyrics in `raw` (one tag value, or several joined), or null when there are none. */
export function parseLyrics(raw: string | null | undefined): Lyrics | null {
  const text = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const rows = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (!rows.some((l) => l.trim())) return null;

  const timed = rows.filter((l) => LEADING_TIMES.test(l));
  const words = rows.filter((l) => l.trim() && !HEADER.test(l));
  // Synced when most lines that say something carry a time, or the only one does (a stray «[1:23]» in a
  // plain verse does not count).
  if (timed.length >= 2 ? timed.length >= words.length / 2 : timed.length === 1 && words.length === 1) {
    let offset = 0;
    const found: { t: number; text: string; n: number }[] = [];
    rows.forEach((row, n) => {
      const head = HEADER.exec(row);
      if (head && !LEADING_TIMES.test(row)) {
        if (head[1].toLowerCase() === 'offset' && /^[+-]?\d+$/.test(head[2].trim())) offset = Number(head[2].trim()) / 1000;
        return;
      }
      const times = LEADING_TIMES.exec(row)?.[0];
      if (!times) return;
      const line = row.slice(times.length).replace(WORD_TIME, '').trim();
      for (const m of times.matchAll(TIME)) found.push({ t: seconds(m[1], m[2]), text: line, n });
    });
    // A positive offset shows the lines earlier.
    found.sort((a, b) => a.t - b.t || a.n - b.n);
    const lines: LyricLine[] = [];
    for (const f of found) {
      const t = Math.max(0, Math.round((f.t - offset) * 1000) / 1000);
      const last = lines.at(-1);
      if (last && last.t !== null && Math.abs(last.t - t) < 0.001 && f.text) {
        if (!last.text) last.text = f.text;
        else (last.tr ??= []).push(f.text);
      } else {
        lines.push({ t, text: f.text });
      }
    }
    // Pauses before the first sung line say nothing.
    while (lines.length && !lines[0].text) lines.shift();
    return lines.length ? { synced: true, lines } : null;
  }

  // Plain: verses keep one blank line between them, none at either end.
  const lines: LyricLine[] = [];
  for (const row of rows) {
    const line = row.trim();
    if (!line && (!lines.length || !lines.at(-1)!.text)) continue;
    lines.push({ t: null, text: line });
  }
  while (lines.length && !lines.at(-1)!.text) lines.pop();
  return { synced: false, lines };
}

/** The line playing at `time` seconds of the track (its index), -1 before the first. */
export function lineAt(lines: LyricLine[], time: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid].t ?? Infinity) <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** A text file's bytes as text: by its byte order mark, else UTF-8, else the legacy encoding it reads as. */
export function decodeText(bytes: Uint8Array): string {
  const tryAs = (label: string, data: Uint8Array = bytes): string | null => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(data);
    } catch {
      return null;
    }
  };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  // UTF-16 without a mark: every other byte of its ASCII ([00:12.34]) is zero.
  const sample = bytes.subarray(0, 400);
  let evenZeros = 0;
  let oddZeros = 0;
  sample.forEach((b, i) => {
    if (b === 0) {
      if (i % 2) oddZeros += 1;
      else evenZeros += 1;
    }
  });
  if (oddZeros > sample.length / 4) return tryAs('utf-16le') ?? new TextDecoder('utf-16le').decode(bytes);
  if (evenZeros > sample.length / 4) return tryAs('utf-16be') ?? new TextDecoder('utf-16be').decode(bytes);
  const utf8 = tryAs('utf-8');
  if (utf8 !== null) return utf8;
  // Japanese files are mostly Shift_JIS, Chinese ones GBK: Shift_JIS when it reads as kana, else GBK.
  const sjis = tryAs('shift_jis');
  if (sjis !== null && /[\u3041-\u3096\u30a1-\u30fa]/.test(sjis)) return sjis;
  return tryAs('gb18030') ?? sjis ?? tryAs('big5') ?? new TextDecoder('utf-8').decode(bytes);
}
