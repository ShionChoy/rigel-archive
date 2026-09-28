// MP3 with new tags: an ID3v2.4 tag (UTF-8, with the cover) in front of the original's audio, whose own
// ID3v2 / ID3v1 / APEv2 tags are left out; the frames stream unchanged from storage. The original's
// ID3v2 frames the catalog has nothing for (lyrics, comments, other pictures …) are carried over.

import { concat, imageSize, utf8 } from './bytes';

const syncsafe = (n: number) => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const readSyncsafe = (b: Uint8Array, at: number) => ((b[at] & 127) << 21) | ((b[at + 1] & 127) << 14) | ((b[at + 2] & 127) << 7) | (b[at + 3] & 127);
const readU32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const FRONT_COVER = 3;

/** Where the audio of an MP3 starts and ends (after a leading ID3v2, before trailing APEv2 / ID3v1). */
export async function mp3AudioRange(size: number, read: (offset: number, length: number) => Promise<Uint8Array>): Promise<{ start: number; end: number }> {
  let start = 0;
  // Some files carry several ID3v2 tags one after another.
  for (let guard = 0; guard < 4; guard += 1) {
    const h = await read(start, 10);
    if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) break;
    start += 10 + readSyncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
  }
  let end = size;
  if (size - start >= 128) {
    const tail = await read(size - 128, 128);
    if (tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47) end -= 128; // "TAG"
  }
  if (end - start >= 32) {
    const ape = await read(end - 32, 32);
    if (new TextDecoder().decode(ape.slice(0, 8)) === 'APETAGEX') {
      const v = new DataView(ape.buffer, ape.byteOffset, 32);
      const tagSize = v.getUint32(12, true); // footer + items
      const hasHeader = (v.getUint32(20, true) & 0x80000000) !== 0;
      end -= tagSize + (hasHeader ? 32 : 0);
    }
  }
  if (end <= start) throw new Error('no MP3 audio');
  return { start, end };
}

// ------------------------------------------------------------------------------------------ the original's frames

export interface Id3Frame {
  id: string; // an ID3v2.4 (or v2.3) frame id
  body: Uint8Array; // the frame's content, usable in a v2.4 tag
}

/** Undo unsynchronisation (0xFF 0x00 → 0xFF). */
function resync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i += 1) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, n);
}

// ID3v2.2's three-letter frames that have a v2.4 counterpart.
const V22: Record<string, string> = {
  TT2: 'TIT2', TT3: 'TIT3', TP1: 'TPE1', TP2: 'TPE2', TP3: 'TPE3', TAL: 'TALB', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER', TCM: 'TCOM',
  TCO: 'TCON', TXT: 'TEXT', TPB: 'TPUB', TEN: 'TENC', TSS: 'TSSE', TBP: 'TBPM', TRC: 'TSRC', TCR: 'TCOP', TXX: 'TXXX', COM: 'COMM',
  ULT: 'USLT', PIC: 'APIC', UFI: 'UFID',
};

/** A v2.2 PIC body as an APIC body (a three-letter image format instead of a MIME type). */
function picToApic(b: Uint8Array): Uint8Array {
  const format = new TextDecoder().decode(b.subarray(1, 4)).toUpperCase();
  const mime = format === 'PNG' ? 'image/png' : format === 'JPG' ? 'image/jpeg' : `image/${format.toLowerCase()}`;
  return concat([b.subarray(0, 1), utf8(mime), new Uint8Array([0]), b.subarray(4)]);
}

/** The frames of the ID3v2 tag at the start of a file (none when there is no readable one). */
export async function readId3Frames(read: (offset: number, length: number) => Promise<Uint8Array>): Promise<Id3Frame[]> {
  const h = await read(0, 10);
  if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return [];
  const major = h[3];
  const flags = h[5];
  if (major < 2 || major > 4) return [];
  let body = await read(10, readSyncsafe(h, 6));
  if (major < 4 && flags & 0x80) body = resync(body);
  let at = 0;
  if (major >= 3 && flags & 0x40) at = major === 4 ? readSyncsafe(body, 0) : 4 + readU32(body, 0); // extended header
  const idLength = major === 2 ? 3 : 4;
  const headLength = major === 2 ? 6 : 10;
  const frames: Id3Frame[] = [];
  while (at + headLength <= body.length) {
    const id = String.fromCharCode(...body.subarray(at, at + idLength));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const length = major === 2 ? (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5] : major === 4 ? readSyncsafe(body, at + 4) : readU32(body, at + 4);
    const format = major === 2 ? 0 : body[at + 9];
    let data = body.subarray(at + headLength, at + headLength + length);
    at += headLength + length;
    if (major === 3) {
      if (format & 0xc0) continue; // compressed or encrypted
      if (format & 0x20) data = data.subarray(1); // group id
    } else if (major === 4) {
      if (format & 0x0c) continue;
      if (format & 0x40) data = data.subarray(1);
      if (format & 0x01) data = data.subarray(4); // data length
      if (format & 0x02 || flags & 0x80) data = resync(data);
    }
    const v4 = major === 2 ? V22[id] : id;
    if (!v4) continue;
    frames.push({ id: v4, body: major === 2 && id === 'PIC' ? picToApic(data) : data.slice() });
  }
  return frames;
}

/** The text up to the terminator in an ID3 frame body, in its encoding (0 Latin-1, 1/2 UTF-16, 3 UTF-8). */
function readText(b: Uint8Array, at: number, encoding: number): { text: string; next: number } {
  const wide = encoding === 1 || encoding === 2;
  let end = at;
  if (wide) while (end + 1 < b.length && !(b[end] === 0 && b[end + 1] === 0)) end += 2;
  else while (end < b.length && b[end] !== 0) end += 1;
  const bytes = b.subarray(at, end);
  const text = encoding === 0
    ? String.fromCharCode(...bytes)
    : new TextDecoder(encoding === 1 ? 'utf-16' : encoding === 2 ? 'utf-16be' : 'utf-8').decode(bytes);
  return { text, next: end + (wide ? 2 : 1) };
}

/** The picture type of an APIC body (3 = front cover). */
export function apicType(b: Uint8Array): number {
  const mime = readText(b, 1, 0);
  return b[mime.next] ?? -1;
}

/** The image in an APIC body. */
export function apicImage(b: Uint8Array): { image: Uint8Array; mime: string } | null {
  const mime = readText(b, 1, 0);
  const description = readText(b, mime.next + 1, b[0]);
  const image = b.subarray(description.next);
  return image.length ? { image, mime: imageSize(image)?.mime ?? mime.text } : null;
}

// v2.3 frames that v2.4 replaced or dropped.
const V23_ONLY = new Set(['TYER', 'TDAT', 'TIME', 'TRDA', 'TSIZ', 'TORY', 'IPLS', 'RVAD', 'EQUA']);

/** The original's frames that go into the new tag: those the catalog writes nothing in place of. */
export function keptFrames(original: Id3Frame[], f: Id3Fields): Id3Frame[] {
  const written = new Set(TEXT_FRAMES.filter(([, k]) => f[k]).map(([id]) => id));
  const customs = new Set(f.custom.filter(([, v]) => v).map(([k]) => k.toLowerCase()));
  const out: Id3Frame[] = [];
  for (const frame of original) {
    const { id, body } = frame;
    if (written.has(id)) continue;
    if (V23_ONLY.has(id)) {
      if (id === 'TYER' && !f.date) out.push({ id: 'TDRC', body }); // the year, when the catalog has no date
      continue;
    }
    if (id === 'TXXX' && customs.has(readText(body, 1, body[0]).text.toLowerCase())) continue;
    if (id === 'UFID' && f.ufid && readText(body, 0, 0).text === f.ufid.owner) continue;
    if (id === 'APIC' && f.cover && apicType(body) === FRONT_COVER) continue;
    out.push(frame);
  }
  return out;
}

// ------------------------------------------------------------------------------------------ the new tag

function frame(id: string, body: Uint8Array): Uint8Array {
  return concat([utf8(id), syncsafe(body.length), new Uint8Array([0, 0]), body]);
}

const text = (id: string, value: string) => frame(id, concat([new Uint8Array([3]), utf8(value)]));
const txxx = (description: string, value: string) => frame('TXXX', concat([new Uint8Array([3]), utf8(description), new Uint8Array([0]), utf8(value)]));

export interface Id3Fields {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  track?: string; // "3/12"
  disc?: string;
  date?: string;
  composer?: string;
  lyricist?: string;
  publisher?: string;
  custom: [string, string][]; // TXXX
  ufid?: { owner: string; id: string };
  cover?: { image: Uint8Array; mime: string } | null;
  keep?: Id3Frame[]; // the original's frames to carry over (keptFrames)
}

const TEXT_FRAMES: [string, keyof Id3Fields][] = [
  ['TIT2', 'title'], ['TPE1', 'artist'], ['TALB', 'album'], ['TPE2', 'albumArtist'], ['TRCK', 'track'], ['TPOS', 'disc'],
  ['TDRC', 'date'], ['TCOM', 'composer'], ['TEXT', 'lyricist'], ['TPUB', 'publisher'],
];

export function id3v24(f: Id3Fields): Uint8Array {
  const frames: Uint8Array[] = [];
  for (const [id, k] of TEXT_FRAMES) {
    const v = f[k];
    if (typeof v === 'string' && v) frames.push(text(id, v));
  }
  for (const [k, v] of f.custom) if (v) frames.push(txxx(k, v));
  if (f.ufid) frames.push(frame('UFID', concat([utf8(f.ufid.owner), new Uint8Array([0]), utf8(f.ufid.id)])));
  if (f.cover) {
    const mime = imageSize(f.cover.image)?.mime ?? f.cover.mime;
    frames.push(frame('APIC', concat([new Uint8Array([3]), utf8(mime), new Uint8Array([0, FRONT_COVER, 0]), f.cover.image])));
  }
  for (const k of f.keep ?? []) frames.push(frame(k.id, k.body));
  const padding = new Uint8Array(1024);
  const body = concat([...frames, padding]);
  return concat([utf8('ID3'), new Uint8Array([4, 0, 0]), syncsafe(body.length), body]);
}
