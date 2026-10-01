// FLAC with new tags: the original's metadata blocks are read from the start of the file, the tag
// (VORBIS_COMMENT) and picture blocks are rebuilt, and the audio frames follow unchanged from storage.
// The catalog's fields replace the original's; fields and pictures the catalog has nothing for stay.

import { concat, imageSize, u32be, utf8 } from './bytes';

const STREAMINFO = 0;
const PADDING = 1;
const VORBIS_COMMENT = 4;
const PICTURE = 6;
const FRONT_COVER = 3;

export interface FlacLayout {
  audioOffset: number; // where the first audio frame starts
  keep: { type: number; body: Uint8Array }[]; // STREAMINFO, SEEKTABLE, CUESHEET, APPLICATION …
  comments: [string, string][]; // the original's tag fields
  pictures: Uint8Array[]; // the original's PICTURE block bodies
}

/** Read the metadata blocks (range reads of `read(offset, length)`): the ones kept as they are, the tags and the pictures. */
export async function readFlacLayout(read: (offset: number, length: number) => Promise<Uint8Array>): Promise<FlacLayout> {
  // Some encoders put an ID3v2 tag in front of «fLaC»: it is skipped (and left out of the new file).
  const id3 = await read(0, 10);
  const base = id3[0] === 0x49 && id3[1] === 0x44 && id3[2] === 0x33
    ? 10 + (((id3[6] & 127) << 21) | ((id3[7] & 127) << 14) | ((id3[8] & 127) << 7) | (id3[9] & 127)) + (id3[5] & 0x10 ? 10 : 0)
    : 0;
  if (base) {
    const inner = await readFlacLayout((offset, length) => read(base + offset, length));
    return { ...inner, audioOffset: base + inner.audioOffset };
  }
  let head = await read(0, 64 * 1024);
  if (head.length < 8 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) throw new Error('not a FLAC file');
  const keep: FlacLayout['keep'] = [];
  const comments: [string, string][] = [];
  const pictures: Uint8Array[] = [];
  let at = 4;
  for (let guard = 0; guard < 1000; guard += 1) {
    if (at + 4 > head.length) head = concat([head, await read(head.length, at + 4 - head.length + 64 * 1024)]);
    const last = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const length = (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3];
    const bodyAt = at + 4;
    if (type !== PADDING) {
      if (bodyAt + length > head.length) head = concat([head, await read(head.length, bodyAt + length - head.length)]);
      const body = head.slice(bodyAt, bodyAt + length);
      if (type === VORBIS_COMMENT) comments.push(...parseVorbisComment(body));
      else if (type === PICTURE) pictures.push(body);
      else keep.push({ type, body });
    }
    at = bodyAt + length;
    if (last) break;
  }
  if (keep[0]?.type !== STREAMINFO) throw new Error('FLAC without STREAMINFO first');
  return { audioOffset: at, keep, comments, pictures };
}

/** The fields of a VORBIS_COMMENT block body (a damaged one gives what could be read). */
export function parseVorbisComment(body: Uint8Array): [string, string][] {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const text = new TextDecoder();
  const out: [string, string][] = [];
  try {
    let at = 4 + v.getUint32(0, true);
    const n = v.getUint32(at, true);
    at += 4;
    for (let i = 0; i < n && at + 4 <= body.length; i += 1) {
      const len = v.getUint32(at, true);
      const field = text.decode(body.subarray(at + 4, at + 4 + len));
      at += 4 + len;
      const eq = field.indexOf('=');
      if (eq > 0) out.push([field.slice(0, eq), field.slice(eq + 1)]);
    }
  } catch {
    // truncated: keep what was read
  }
  return out;
}

/** A VORBIS_COMMENT block body: vendor string, then NAME=value fields. */
export function vorbisComment(fields: [string, string][], vendor = 'Rigël Archive'): Uint8Array {
  const le = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const v = utf8(vendor);
  const parts = [le(v.length), v, le(fields.length)];
  for (const [k, value] of fields) {
    const f = utf8(`${k.toUpperCase()}=${value}`);
    parts.push(le(f.length), f);
  }
  return concat(parts);
}

/** The picture type of a PICTURE block body (3 = front cover). */
export const pictureType = (body: Uint8Array) => (body.length >= 4 ? ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) >>> 0 : -1);

/** The image in a PICTURE block body. */
export function pictureImage(body: Uint8Array): { image: Uint8Array; mime: string } | null {
  try {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let at = 4;
    const mimeLen = v.getUint32(at);
    const mime = new TextDecoder().decode(body.subarray(at + 4, at + 4 + mimeLen));
    at += 4 + mimeLen;
    at += 4 + v.getUint32(at); // description
    at += 16; // width, height, depth, colours
    const len = v.getUint32(at);
    const image = body.subarray(at + 4, at + 4 + len);
    return image.length === len ? { image, mime: imageSize(image)?.mime ?? mime } : null;
  } catch {
    return null;
  }
}

/** A PICTURE block body (the front cover unless another type is given). */
export function pictureBlock(image: Uint8Array, mime: string, type = FRONT_COVER, description = ''): Uint8Array {
  const size = imageSize(image);
  const m = utf8(size?.mime ?? mime);
  const d = utf8(description);
  return concat([
    u32be(type),
    u32be(m.length), m,
    u32be(d.length), d,
    u32be(size?.width ?? 0), u32be(size?.height ?? 0), u32be(24), u32be(0),
    u32be(image.length), image,
  ]);
}

/** «fLaC» and the metadata blocks of the new file, with some padding for later tag edits. */
export function flacHeader(layout: FlacLayout, comment: Uint8Array, pictures: Uint8Array[]): Uint8Array {
  const blocks: { type: number; body: Uint8Array }[] = [
    ...layout.keep,
    { type: VORBIS_COMMENT, body: comment },
    ...pictures.map((body) => ({ type: PICTURE, body })),
    { type: PADDING, body: new Uint8Array(4096) },
  ];
  const parts: Uint8Array[] = [utf8('fLaC')];
  blocks.forEach((b, i) => {
    if (b.body.length >= 1 << 24) throw new Error('metadata block too large');
    const last = i === blocks.length - 1 ? 0x80 : 0;
    parts.push(new Uint8Array([last | b.type, (b.body.length >> 16) & 255, (b.body.length >> 8) & 255, b.body.length & 255]), b.body);
  });
  return concat(parts);
}
