// MP3 with new tags: an ID3v2.4 tag (UTF-8, with the cover) in front of the original's audio, whose own
// ID3v2 / ID3v1 / APEv2 tags are left out; the frames stream unchanged from storage.

import { concat, imageSize, utf8 } from './bytes';

const syncsafe = (n: number) => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const readSyncsafe = (b: Uint8Array, at: number) => ((b[at] & 127) << 21) | ((b[at + 1] & 127) << 14) | ((b[at + 2] & 127) << 7) | (b[at + 3] & 127);

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
}

export function id3v24(f: Id3Fields): Uint8Array {
  const frames: Uint8Array[] = [];
  const add = (id: string, v?: string) => {
    if (v) frames.push(text(id, v));
  };
  add('TIT2', f.title);
  add('TPE1', f.artist);
  add('TALB', f.album);
  add('TPE2', f.albumArtist);
  add('TRCK', f.track);
  add('TPOS', f.disc);
  add('TDRC', f.date);
  add('TCOM', f.composer);
  add('TEXT', f.lyricist);
  add('TPUB', f.publisher);
  for (const [k, v] of f.custom) if (v) frames.push(txxx(k, v));
  if (f.ufid) frames.push(frame('UFID', concat([utf8(f.ufid.owner), new Uint8Array([0]), utf8(f.ufid.id)])));
  if (f.cover) {
    const mime = imageSize(f.cover.image)?.mime ?? f.cover.mime;
    frames.push(frame('APIC', concat([new Uint8Array([3]), utf8(mime), new Uint8Array([0, 3, 0]), f.cover.image])));
  }
  const padding = new Uint8Array(1024);
  const body = concat([...frames, padding]);
  return concat([utf8('ID3'), new Uint8Array([4, 0, 0]), syncsafe(body.length), body]);
}
