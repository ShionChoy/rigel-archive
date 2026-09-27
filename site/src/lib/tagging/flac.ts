// FLAC with new tags: the original's metadata blocks are read from the start of the file, the tag
// (VORBIS_COMMENT) and picture blocks are replaced, and the audio frames follow unchanged from storage.

import { concat, imageSize, u32be, utf8 } from './bytes';

const STREAMINFO = 0;
const PADDING = 1;
const VORBIS_COMMENT = 4;
const PICTURE = 6;

export interface FlacLayout {
  audioOffset: number; // where the first audio frame starts
  keep: { type: number; body: Uint8Array }[]; // STREAMINFO, SEEKTABLE, CUESHEET, APPLICATION …
}

/** Read the metadata block headers (range reads of `read(offset, length)`), keeping all but tags and pictures. */
export async function readFlacLayout(read: (offset: number, length: number) => Promise<Uint8Array>): Promise<FlacLayout> {
  let head = await read(0, 64 * 1024);
  if (head.length < 8 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) throw new Error('not a FLAC file');
  const keep: FlacLayout['keep'] = [];
  let at = 4;
  for (let guard = 0; guard < 1000; guard += 1) {
    if (at + 4 > head.length) head = concat([head, await read(head.length, at + 4 - head.length + 64 * 1024)]);
    const last = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const length = (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3];
    const bodyAt = at + 4;
    if (type !== VORBIS_COMMENT && type !== PICTURE && type !== PADDING) {
      if (bodyAt + length > head.length) head = concat([head, await read(head.length, bodyAt + length - head.length)]);
      keep.push({ type, body: head.slice(bodyAt, bodyAt + length) });
    }
    at = bodyAt + length;
    if (last) break;
  }
  if (keep[0]?.type !== STREAMINFO) throw new Error('FLAC without STREAMINFO first');
  return { audioOffset: at, keep };
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

/** A PICTURE block body for the front cover. */
export function pictureBlock(image: Uint8Array, mime: string): Uint8Array {
  const size = imageSize(image);
  const m = utf8(size?.mime ?? mime);
  return concat([
    u32be(3), // front cover
    u32be(m.length), m,
    u32be(0), // no description
    u32be(size?.width ?? 0), u32be(size?.height ?? 0), u32be(24), u32be(0),
    u32be(image.length), image,
  ]);
}

/** «fLaC» and the metadata blocks of the new file, with some padding for later tag edits. */
export function flacHeader(layout: FlacLayout, comment: Uint8Array, picture: Uint8Array | null): Uint8Array {
  const blocks: { type: number; body: Uint8Array }[] = [
    ...layout.keep,
    { type: VORBIS_COMMENT, body: comment },
    ...(picture ? [{ type: PICTURE, body: picture }] : []),
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
