// What an audio file carries itself (文件原值): its tags and pictures, read with range reads from the
// head (and, for MP3 and WAV, the tail) of the stored file, never the whole file. FLAC (Vorbis comments,
// PICTURE blocks), MP3 (ID3v2.2–2.4, APEv2, ID3v1), WAV (RIFF INFO and an id3 chunk), AIFF (ID3 chunk),
// MP4 / M4A (the iTunes item list) and Ogg Vorbis / Opus (Vorbis comments with embedded pictures).

import { concat, imageSize } from './bytes';
import { parseVorbisComment, pictureImage, pictureType } from './flac';
import { apeTag, addValue, id3Tag, mp4Tag, riffTag, splitNumber, splitPerformer, vorbisTag, PERFORMER, type Tags } from './names';

export type Read = (offset: number, length: number) => Promise<Uint8Array>;

export interface Picture {
  image: Uint8Array;
  mime: string;
  type: number; // ID3 / FLAC picture type: 3 front cover, 4 back cover, 0 other …
  description: string;
}

export interface Embedded {
  format: string; // what was read: vorbis, id3v2.3, riff+id3v2.4, mp4 …
  native: [string, string][]; // fields as the file stores them
  tags: Tags;
  pictures: Picture[];
}

const MAX_TAG = 64 * 1024 * 1024; // a tag larger than this is not read (a broken size)
const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
let sjis: TextDecoder | null | undefined;

/** Bytes in a legacy 8-bit field: UTF-8 when valid, else Shift-JIS when it decodes cleanly (Japanese files), else Latin-1. */
export function legacyText(b: Uint8Array): string {
  if (b.every((c) => c < 0x80)) return latin1.decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    // not UTF-8
  }
  if (sjis === undefined) {
    try {
      sjis = new TextDecoder('shift_jis', { fatal: true });
    } catch {
      sjis = null;
    }
  }
  if (sjis) {
    try {
      return sjis.decode(b);
    } catch {
      // not Shift-JIS either
    }
  }
  return latin1.decode(b);
}

const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const syncsafe = (b: Uint8Array, at: number) => ((b[at] & 127) << 21) | ((b[at + 1] & 127) << 14) | ((b[at + 2] & 127) << 7) | (b[at + 3] & 127);
const ascii = (b: Uint8Array, at: number, n: number) => latin1.decode(b.subarray(at, at + n));

function empty(format: string): Embedded {
  return { format, native: [], tags: {}, pictures: [] };
}

function picture(image: Uint8Array, mime: string, type: number, description: string): Picture | null {
  if (image.length === 0) return null;
  return { image: image.slice(), mime: imageSize(image)?.mime ?? mime, type, description };
}

// ------------------------------------------------------------------------------------------ Vorbis comments

function fromVorbis(out: Embedded, fields: [string, string][]) {
  for (const [key, value] of fields) {
    const k = key.toUpperCase();
    if (k === 'METADATA_BLOCK_PICTURE') {
      try {
        const body = Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0));
        const img = pictureImage(body);
        const p = img && picture(img.image, img.mime, pictureType(body), '');
        if (p) out.pictures.push(p);
      } catch {
        // not base64
      }
      out.native.push([key, '<picture>']);
      continue;
    }
    if (k === 'COVERART') {
      try {
        const image = Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0));
        const p = picture(image, fields.find(([x]) => x.toUpperCase() === 'COVERARTMIME')?.[1] ?? 'image/jpeg', 3, '');
        if (p) out.pictures.push(p);
      } catch {
        // not base64
      }
      out.native.push([key, '<picture>']);
      continue;
    }
    out.native.push([key, value]);
    if (k === 'COVERARTMIME') continue;
    const tag = vorbisTag(key);
    if (tag === 'performer') {
      const [role, name] = splitPerformer(value);
      addValue(out.tags, `${PERFORMER}${role || 'performer'}`, name);
    } else if (tag === 'tracknumber' || tag === 'discnumber') {
      const [n, total] = splitNumber(value);
      addValue(out.tags, tag, n);
      if (total) addValue(out.tags, tag === 'tracknumber' ? 'totaltracks' : 'totaldiscs', total);
    } else addValue(out.tags, tag, value);
  }
}

// ------------------------------------------------------------------------------------------ FLAC

async function readFlac(read: Read, size: number): Promise<Embedded> {
  let base = 0;
  const h = await read(0, 10);
  if (ascii(h, 0, 3) === 'ID3') base = 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0); // a stray ID3v2 in front
  const out = empty('vorbis');
  let head = await read(base, 64 * 1024);
  if (ascii(head, 0, 4) !== 'fLaC') throw new Error('not a FLAC file');
  let at = 4;
  for (let guard = 0; guard < 1000; guard += 1) {
    if (at + 4 > head.length) head = concat([head, await read(base + head.length, at + 4 - head.length + 64 * 1024)]);
    if (at + 4 > head.length) break;
    const last = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const length = (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3];
    const bodyAt = at + 4;
    if (type === 4 || type === 6) {
      if (base + bodyAt + length > size) break;
      if (bodyAt + length > head.length) head = concat([head, await read(base + head.length, bodyAt + length - head.length)]);
      const body = head.subarray(bodyAt, bodyAt + length);
      if (type === 4) fromVorbis(out, parseVorbisComment(body));
      else {
        const img = pictureImage(body);
        const p = img && picture(img.image, img.mime, pictureType(body), '');
        if (p) out.pictures.push(p);
      }
    }
    at = bodyAt + length;
    if (last) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ ID3v2

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B',
  'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient',
  'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave',
  'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap',
  'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk',
  'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

function genreName(value: string): string {
  const m = /^\((\d+)\)(.*)$/.exec(value.trim());
  if (m) return m[2].trim() || ID3V1_GENRES[Number(m[1])] || value;
  if (/^\d+$/.test(value.trim())) return ID3V1_GENRES[Number(value)] ?? value;
  return value;
}

function resync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i += 1) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, n);
}

/** Text in an ID3 frame body from `at` to the end, split at terminators. */
function id3Strings(b: Uint8Array, at: number, encoding: number): string[] {
  const wide = encoding === 1 || encoding === 2;
  const out: string[] = [];
  let start = at;
  const push = (end: number) => {
    const bytes = b.subarray(start, end);
    let s: string;
    if (encoding === 0) s = legacyText(bytes);
    else if (encoding === 3) s = utf8.decode(bytes);
    else if (encoding === 1) s = new TextDecoder(bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le').decode(bytes);
    else s = new TextDecoder('utf-16be').decode(bytes);
    out.push(s.replace(/^﻿/, ''));
  };
  const step = wide ? 2 : 1;
  for (let i = at; i + step <= b.length; i += step) {
    if (wide ? b[i] === 0 && b[i + 1] === 0 : b[i] === 0) {
      push(i);
      start = i + step;
    }
  }
  if (start < b.length) push(b.length);
  return out;
}

/** One terminated string from `at`: its text and where the rest starts. */
function id3String(b: Uint8Array, at: number, encoding: number): { text: string; next: number } {
  const wide = encoding === 1 || encoding === 2;
  let end = at;
  if (wide) while (end + 1 < b.length && !(b[end] === 0 && b[end + 1] === 0)) end += 2;
  else while (end < b.length && b[end] !== 0) end += 1;
  const [text] = id3Strings(b.subarray(0, end), at, encoding);
  return { text: text ?? '', next: Math.min(b.length, end + (wide ? 2 : 1)) };
}

const V22: Record<string, string> = {
  TT1: 'TIT1', TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TP4: 'TPE4', TAL: 'TALB', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER',
  TDA: 'TDAT', TCM: 'TCOM', TCO: 'TCON', TXT: 'TEXT', TPB: 'TPUB', TEN: 'TENC', TSS: 'TSSE', TBP: 'TBPM', TRC: 'TSRC', TCR: 'TCOP', TXX: 'TXXX',
  COM: 'COMM', ULT: 'USLT', PIC: 'APIC', UFI: 'UFID', TOA: 'TOPE', TOT: 'TOAL', TOR: 'TORY', TMT: 'TMED', TLA: 'TLAN', TKE: 'TKEY', WAR: 'WOAR',
  TCP: 'TCMP', TOF: 'TOFN',
};

function fromId3Frame(out: Embedded, id: string, data: Uint8Array, major: number, v22: string) {
  if (id === 'APIC') {
    if (v22 === 'PIC') {
      const format = ascii(data, 1, 3).toUpperCase();
      const d = id3String(data, 5, data[0]);
      const p = picture(data.subarray(d.next), format === 'PNG' ? 'image/png' : 'image/jpeg', data[4], d.text);
      if (p) out.pictures.push(p);
    } else {
      const mime = id3String(data, 1, 0);
      const type = data[mime.next] ?? 0;
      const d = id3String(data, mime.next + 1, data[0]);
      const p = picture(data.subarray(d.next), mime.text, type, d.text);
      if (p) out.pictures.push(p);
    }
    out.native.push([id, '<picture>']);
    return;
  }
  if (id === 'TXXX') {
    const d = id3String(data, 1, data[0]);
    const values = id3Strings(data, d.next, data[0]);
    out.native.push([`TXXX:${d.text}`, values.join('; ')]);
    const tag = id3Tag('TXXX', d.text);
    if (tag) for (const v of values) addValue(out.tags, tag, v);
    return;
  }
  if (id === 'COMM' || id === 'USLT') {
    const d = id3String(data, 4, data[0]);
    const text = id3Strings(data, d.next, data[0]).join('\n');
    out.native.push([d.text ? `${id}:${d.text}` : id, text]);
    // Comments with a description (iTunNORM, iTunSMPB …) are machine data, not the comment.
    if (id === 'USLT' || !d.text) addValue(out.tags, id === 'COMM' ? 'comment' : 'lyrics', text);
    return;
  }
  if (id === 'UFID') {
    const owner = id3String(data, 0, 0);
    const value = latin1.decode(data.subarray(owner.next));
    out.native.push([`UFID:${owner.text}`, value]);
    const tag = id3Tag('UFID', owner.text);
    if (tag) addValue(out.tags, tag, value);
    return;
  }
  if (id === 'TIPL' || id === 'TMCL' || id === 'IPLS') {
    const list = id3Strings(data, 1, data[0]);
    out.native.push([id, list.join('; ')]);
    for (let i = 0; i + 1 < list.length; i += 2) {
      const tag = id3Tag(id === 'IPLS' ? 'TIPL' : id, list[i]);
      if (tag) addValue(out.tags, tag, list[i + 1]);
    }
    return;
  }
  if (id.startsWith('W')) {
    const value = id === 'WXXX' ? latin1.decode(data.subarray(id3String(data, 1, data[0]).next)) : latin1.decode(data);
    out.native.push([id, value.replace(/\u0000+$/, '')]);
    const tag = id3Tag(id);
    if (tag) addValue(out.tags, tag, value);
    return;
  }
  if (id.startsWith('T')) {
    // v2.4 separates several values with NUL; v2.3 has one value (a «/» may be part of it).
    const values = id3Strings(data, 1, data[0]).filter((v, i, a) => v || i < a.length - 1);
    out.native.push([id, values.join(major === 4 ? '; ' : '')]);
    if (id === 'TRCK' || id === 'TPOS') {
      const [n, total] = splitNumber(values[0] ?? '');
      addValue(out.tags, id === 'TRCK' ? 'tracknumber' : 'discnumber', n);
      if (total) addValue(out.tags, id === 'TRCK' ? 'totaltracks' : 'totaldiscs', total);
      return;
    }
    if (id === 'TDAT' || id === 'TIME') return; // folded into the date below
    const tag = id3Tag(id);
    if (!tag) return;
    for (const v of values) addValue(out.tags, tag, id === 'TCON' ? genreName(v) : v);
    return;
  }
  out.native.push([id, `<${data.length} bytes>`]);
}

/** The ID3v2 tag whose header is at `base` (a WAV or AIFF chunk, or the start of an MP3). Returns its total size. */
async function readId3v2(read: Read, base: number, out: Embedded): Promise<number> {
  const h = await read(base, 10);
  if (h.length < 10 || ascii(h, 0, 3) !== 'ID3') return 0;
  const major = h[3];
  const flags = h[5];
  const size = syncsafe(h, 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (major < 2 || major > 4 || size > MAX_TAG) return total;
  out.format = out.format ? `${out.format}+id3v2.${major}` : `id3v2.${major}`;
  let body = await read(base + 10, size);
  if (major < 4 && flags & 0x80) body = resync(body);
  let at = 0;
  if (major >= 3 && flags & 0x40) at = major === 4 ? syncsafe(body, 0) : 4 + u32be(body, 0);
  const idLength = major === 2 ? 3 : 4;
  const headLength = major === 2 ? 6 : 10;
  let year = '';
  let dayMonth = '';
  while (at + headLength <= body.length) {
    const raw = ascii(body, at, idLength);
    if (!/^[A-Z0-9]+$/.test(raw)) break;
    const length = major === 2 ? (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5] : major === 4 ? syncsafe(body, at + 4) : u32be(body, at + 4);
    const format = major === 2 ? 0 : body[at + 9];
    let data = body.subarray(at + headLength, Math.min(body.length, at + headLength + length));
    at += headLength + length;
    if (major === 3) {
      if (format & 0xc0) continue;
      if (format & 0x20) data = data.subarray(1);
    } else if (major === 4) {
      if (format & 0x0c) continue;
      if (format & 0x40) data = data.subarray(1);
      if (format & 0x01) data = data.subarray(4);
      if (format & 0x02 || flags & 0x80) data = resync(data); // unsynchronised (every frame, when the tag says so)
    }
    const id = major === 2 ? V22[raw] ?? raw : raw;
    if (id === 'TYER') year = id3Strings(data, 1, data[0])[0] ?? '';
    if (id === 'TDAT') dayMonth = id3Strings(data, 1, data[0])[0] ?? '';
    fromId3Frame(out, id, data, major, raw);
  }
  // v2.3 keeps the year and «DDMM» apart.
  if (year && !out.tags.date?.some((d) => d.length > 4) && /^\d{4}$/.test(dayMonth)) {
    out.tags.date = [`${year.slice(0, 4)}-${dayMonth.slice(2, 4)}-${dayMonth.slice(0, 2)}`];
  }
  return total;
}

// ------------------------------------------------------------------------------------------ MP3 tails

async function readApe(read: Read, end: number, out: Embedded): Promise<number> {
  if (end < 32) return 0;
  const f = await read(end - 32, 32);
  if (ascii(f, 0, 8) !== 'APETAGEX') return 0;
  const tagSize = u32le(f, 12);
  const count = u32le(f, 16);
  const hasHeader = (u32le(f, 20) & 0x80000000) !== 0;
  if (tagSize > MAX_TAG || tagSize < 32 || tagSize > end) return 0;
  const items = await read(end - tagSize, tagSize - 32);
  out.format = out.format ? `${out.format}+ape` : 'ape';
  let at = 0;
  for (let i = 0; i < count && at + 8 < items.length; i += 1) {
    const len = u32le(items, at);
    const flags = u32le(items, at + 4);
    let k = at + 8;
    while (k < items.length && items[k] !== 0) k += 1;
    const key = ascii(items, at + 8, k - at - 8);
    const value = items.subarray(k + 1, k + 1 + len);
    at = k + 1 + len;
    if ((flags >> 1) & 3) {
      // binary: «Cover Art (Front)» = file name, NUL, image
      if (/^cover art/i.test(key)) {
        const z = value.indexOf(0);
        const p = picture(value.subarray(z + 1), 'image/jpeg', /front/i.test(key) ? 3 : /back/i.test(key) ? 4 : 0, '');
        if (p) out.pictures.push(p);
      }
      out.native.push([`APE:${key}`, '<binary>']);
      continue;
    }
    const text = utf8.decode(value);
    out.native.push([`APE:${key}`, text]);
    const tag = apeTag(key);
    for (const v of text.split('\u0000')) {
      if (tag === 'tracknumber' || tag === 'discnumber') {
        const [n, total] = splitNumber(v);
        addValue(out.tags, tag, n);
        if (total) addValue(out.tags, tag === 'tracknumber' ? 'totaltracks' : 'totaldiscs', total);
      } else addValue(out.tags, tag, v);
    }
  }
  return tagSize + (hasHeader ? 32 : 0);
}

function readId3v1(t: Uint8Array, out: Embedded) {
  const field = (at: number, n: number) => {
    let end = at;
    while (end < at + n && t[end] !== 0) end += 1;
    return legacyText(t.subarray(at, end)).trim();
  };
  const v1: [string, string][] = [['title', field(3, 30)], ['artist', field(33, 30)], ['album', field(63, 30)], ['date', field(93, 4)]];
  const track = t[125] === 0 && t[126] !== 0 ? String(t[126]) : '';
  out.format = out.format ? `${out.format}+id3v1` : 'id3v1';
  for (const [k, v] of v1) {
    if (!v) continue;
    out.native.push([`ID3v1:${k}`, v]);
    if (!out.tags[k]) addValue(out.tags, k, v);
  }
  if (track && !out.tags.tracknumber) addValue(out.tags, 'tracknumber', track);
  const genre = ID3V1_GENRES[t[127]];
  if (genre && !out.tags.genre) addValue(out.tags, 'genre', genre);
}

async function readMp3(read: Read, size: number): Promise<Embedded> {
  const out = empty('');
  await readId3v2(read, 0, out);
  let end = size;
  if (size >= 128) {
    const t = await read(size - 128, 128);
    if (ascii(t, 0, 3) === 'TAG') {
      end -= 128;
      if (!out.format.startsWith('id3v2')) readId3v1(t, out);
    }
  }
  await readApe(read, end, out);
  if (!out.format) out.format = 'none';
  return out;
}

// ------------------------------------------------------------------------------------------ WAV and AIFF

async function readRiff(read: Read, size: number): Promise<Embedded> {
  const out = empty('');
  const h = await read(0, 12);
  if (ascii(h, 0, 4) !== 'RIFF' || ascii(h, 8, 4) !== 'WAVE') return { ...out, format: 'none' };
  let at = 12;
  for (let guard = 0; guard < 200 && at + 8 <= size; guard += 1) {
    const c = await read(at, 12);
    const id = ascii(c, 0, 4);
    const len = u32le(c, 4);
    if (id === 'LIST' && ascii(c, 8, 4) === 'INFO' && len < MAX_TAG) {
      const body = await read(at + 12, len - 4);
      out.format = out.format ? `${out.format}+riff` : 'riff';
      let i = 0;
      while (i + 8 <= body.length) {
        const sub = ascii(body, i, 4);
        const n = u32le(body, i + 4);
        let end = i + 8 + n;
        while (end > i + 8 && body[end - 1] === 0) end -= 1;
        const value = legacyText(body.subarray(i + 8, Math.min(end, body.length))).trim();
        out.native.push([`INFO:${sub}`, value]);
        const tag = riffTag(sub);
        if (tag && value) {
          if (tag === 'tracknumber') addValue(out.tags, tag, splitNumber(value)[0]);
          else if (!out.tags[tag] || !out.format.includes('id3')) addValue(out.tags, tag, value);
        }
        i += 8 + n + (n & 1);
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && len < MAX_TAG) {
      // The id3 chunk (Picard, foobar2000) wins over INFO: it is read into a fresh set, then merged.
      const tagged = empty('');
      await readId3v2(read, at + 8, tagged);
      out.format = out.format ? `${out.format}+${tagged.format}` : tagged.format;
      out.native.push(...tagged.native);
      out.pictures.push(...tagged.pictures);
      out.tags = { ...out.tags, ...tagged.tags };
    }
    at += 8 + len + (len & 1);
    if (len === 0 && id !== 'LIST') break;
  }
  if (!out.format) out.format = 'none';
  return out;
}

async function readAiff(read: Read, size: number): Promise<Embedded> {
  const out = empty('');
  const h = await read(0, 12);
  if (ascii(h, 0, 4) !== 'FORM') return { ...out, format: 'none' };
  let at = 12;
  for (let guard = 0; guard < 200 && at + 8 <= size; guard += 1) {
    const c = await read(at, 8);
    const id = ascii(c, 0, 4);
    const len = u32be(c, 4);
    if ((id === 'ID3 ' || id === 'id3 ') && len < MAX_TAG) await readId3v2(read, at + 8, out);
    else if ((id === 'NAME' || id === 'AUTH' || id === 'ANNO' || id === '(c) ') && len < 65536) {
      const value = legacyText(await read(at + 8, len)).replace(/\u0000+$/, '').trim();
      out.native.push([id.trim(), value]);
      const tag = id === 'NAME' ? 'title' : id === 'AUTH' ? 'artist' : id === 'ANNO' ? 'comment' : 'copyright';
      if (!out.tags[tag]) addValue(out.tags, tag, value);
    }
    at += 8 + len + (len & 1);
    if (len === 0) break;
  }
  if (!out.format) out.format = 'none';
  return out;
}

// ------------------------------------------------------------------------------------------ MP4 / M4A

interface Atom {
  type: string;
  start: number; // of the header
  body: number; // of the content
  end: number;
}

/** The atoms in b[from, to) (a parent's content). */
function atoms(b: Uint8Array, from: number, to: number): Atom[] {
  const out: Atom[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32be(b, at);
    const type = latin1.decode(b.subarray(at + 4, at + 8));
    let body = at + 8;
    if (size === 1) {
      size = u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

const MP4_GENRES = ['', ...ID3V1_GENRES];

async function readMp4(read: Read, size: number): Promise<Embedded> {
  const out = empty('mp4');
  // Find moov among the top-level atoms (reading only their headers).
  let at = 0;
  let moov: { start: number; size: number } | null = null;
  for (let guard = 0; guard < 100 && at + 8 <= size; guard += 1) {
    const h = await read(at, 16);
    let len = u32be(h, 0);
    const type = ascii(h, 4, 4);
    if (len === 1) len = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    else if (len === 0) len = size - at;
    if (len < 8) break;
    if (type === 'moov') {
      moov = { start: at, size: len };
      break;
    }
    at += len;
  }
  if (!moov || moov.size > MAX_TAG) return { ...out, format: 'none' };
  const m = await read(moov.start, moov.size);
  const top = atoms(m, 8, m.length);
  const udta = top.find((a) => a.type === 'udta');
  const meta = udta && atoms(m, udta.body, udta.end).find((a) => a.type === 'meta');
  if (!meta) return out;
  // «meta» is a full atom (4 bytes of version and flags) in iTunes files, a plain one in some QuickTime files.
  const plain = ['hdlr', 'ilst', 'free'].includes(latin1.decode(m.subarray(meta.body + 4, meta.body + 8)));
  const ilst = atoms(m, meta.body + (plain ? 0 : 4), meta.end).find((a) => a.type === 'ilst');
  if (!ilst) return out;
  for (const item of atoms(m, ilst.body, ilst.end)) {
    const kids = atoms(m, item.body, item.end);
    let name = item.type;
    if (item.type === '----') {
      const n = kids.find((k) => k.type === 'name');
      name = `----:${n ? utf8.decode(m.subarray(n.body + 4, n.end)) : ''}`;
    }
    for (const d of kids.filter((k) => k.type === 'data')) {
      const kind = u32be(m, d.body) & 0xffffff;
      const payload = m.subarray(d.body + 8, d.end);
      if (name === 'covr') {
        const p = picture(payload, kind === 14 ? 'image/png' : 'image/jpeg', 3, '');
        if (p) out.pictures.push(p);
        out.native.push(['covr', '<picture>']);
        continue;
      }
      if (name === 'trkn' || name === 'disk') {
        const n = payload.length >= 4 ? (payload[2] << 8) | payload[3] : 0;
        const total = payload.length >= 6 ? (payload[4] << 8) | payload[5] : 0;
        out.native.push([name, total ? `${n}/${total}` : String(n)]);
        if (n) addValue(out.tags, name === 'trkn' ? 'tracknumber' : 'discnumber', String(n));
        if (total) addValue(out.tags, name === 'trkn' ? 'totaltracks' : 'totaldiscs', String(total));
        continue;
      }
      let value: string;
      if (kind === 1) value = utf8.decode(payload);
      else if (kind === 2) value = new TextDecoder('utf-16be').decode(payload);
      else if (kind === 21 || kind === 22 || (kind === 0 && payload.length <= 8 && name !== '----')) {
        value = String(payload.reduce((n, b) => n * 256 + b, 0));
        if (name === 'gnre') value = MP4_GENRES[Number(value)] ?? value;
      } else value = kind === 0 ? utf8.decode(payload) : `<${payload.length} bytes>`;
      out.native.push([name, value]);
      const tag = name === 'gnre' ? 'genre' : mp4Tag(name);
      if (tag && !value.startsWith('<')) addValue(out.tags, tag, value);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ Ogg

/** The first packets of the file's first logical stream (enough to reach its comment header). */
async function oggPackets(read: Read, size: number, wanted: number): Promise<Uint8Array[]> {
  let chunk = 64 * 1024;
  for (;;) {
    const b = await read(0, Math.min(size, chunk));
    const packets: Uint8Array[] = [];
    let current: Uint8Array[] = [];
    let at = 0;
    let serial = -1;
    while (at + 27 <= b.length && packets.length < wanted) {
      if (ascii(b, at, 4) !== 'OggS') return packets;
      const n = b[at + 26];
      if (at + 27 + n > b.length) break;
      const lacing = b.subarray(at + 27, at + 27 + n);
      let data = at + 27 + n;
      const pageEnd = data + lacing.reduce((s, x) => s + x, 0);
      if (pageEnd > b.length) break;
      const pageSerial = u32le(b, at + 14);
      if (serial === -1) serial = pageSerial;
      if (pageSerial === serial) {
        // A lacing value below 255 ends a packet; a packet may go on in the next page.
        for (const l of lacing) {
          current.push(b.subarray(data, data + l));
          data += l;
          if (l < 255) {
            packets.push(concat(current));
            current = [];
          }
        }
      }
      at = pageEnd;
    }
    if (packets.length >= wanted || chunk >= size || chunk >= MAX_TAG) return packets;
    chunk *= 4;
  }
}

async function readOgg(read: Read, size: number): Promise<Embedded> {
  const packets = await oggPackets(read, size, 2);
  const first = packets[0];
  const second = packets[1];
  if (!first || !second) return empty('none');
  let comment: Uint8Array | null = null;
  let format = 'ogg';
  if (ascii(first, 1, 6) === 'vorbis' && second[0] === 3 && ascii(second, 1, 6) === 'vorbis') {
    comment = second.subarray(7);
    format = 'vorbis';
  } else if (ascii(first, 0, 8) === 'OpusHead' && ascii(second, 0, 8) === 'OpusTags') {
    comment = second.subarray(8);
    format = 'opus';
  }
  const out = empty(format);
  if (comment) fromVorbis(out, parseVorbisComment(comment));
  return out;
}

// ------------------------------------------------------------------------------------------ all

/** Read what a stored audio file carries. Unknown formats give an empty result (format «none»). */
export async function readEmbedded(read: Read, size: number, ext: string): Promise<Embedded> {
  const e = ext.toLowerCase();
  if (e === 'flac') return readFlac(read, size);
  if (e === 'mp3' || e === 'aac') return readMp3(read, size);
  if (e === 'wav') return readRiff(read, size);
  if (e === 'aif' || e === 'aiff') return readAiff(read, size);
  if (e === 'm4a' || e === 'mp4' || e === 'm4b') return readMp4(read, size);
  if (e === 'ogg' || e === 'opus' || e === 'oga') return readOgg(read, size);
  return empty('none');
}

/** The front cover (type 3), else the first picture. */
export function frontCover<P extends { type: number }>(pictures: P[]): P | undefined {
  return pictures.find((p) => p.type === 3) ?? pictures[0];
}
