// Ogg Vorbis / Opus with new tags: the comment header is rebuilt (pictures as METADATA_BLOCK_PICTURE) and
// the header pages after the first are written again. The audio pages follow unchanged; when the header
// now takes a different number of pages, every later page of the stream gets its sequence number moved
// and its checksum recomputed as it streams (renumberOgg).

import { concat, u32le, utf8 } from './bytes';
import { parseVorbisComment, pictureBlock } from './flac';
import type { Tags } from './names';
import type { Read } from './read';
import type { Layout, WriteSpec } from './write';

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** The checksum of a page (its checksum field taken as zero). */
export function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i += 1) {
    const b = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 255]) >>> 0;
  }
  return crc;
}

const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

interface Page {
  start: number;
  end: number;
  serial: number;
  seq: number;
  lacing: Uint8Array;
  body: number; // where the data starts
}

function parsePage(b: Uint8Array, at: number): Page | null {
  if (at + 27 > b.length || b[at] !== 0x4f || b[at + 1] !== 0x67 || b[at + 2] !== 0x67 || b[at + 3] !== 0x53) return null;
  const n = b[at + 26];
  if (at + 27 + n > b.length) return null;
  const lacing = b.subarray(at + 27, at + 27 + n);
  const end = at + 27 + n + lacing.reduce((s, x) => s + x, 0);
  if (end > b.length) return null;
  return { start: at, end, serial: u32(b, at + 14), seq: u32(b, at + 18), lacing, body: at + 27 + n };
}

/** Pages carrying these packets, numbered from `seq` (header pages: granule position 0). */
function paginate(packets: Uint8Array[], serial: number, seq: number): Uint8Array[] {
  const segments: { data: Uint8Array; lace: number; first: boolean }[] = [];
  for (const p of packets) {
    for (let i = 0; i <= p.length; i += 255) {
      const len = Math.min(255, p.length - i);
      segments.push({ data: p.subarray(i, i + len), lace: len, first: i === 0 });
      if (len < 255) break;
    }
  }
  const pages: Uint8Array[] = [];
  for (let i = 0; i < segments.length; i += 255) {
    const segs = segments.slice(i, i + 255);
    const continued = i > 0 && !segs[0].first;
    const header = new Uint8Array(27 + segs.length);
    header.set([0x4f, 0x67, 0x67, 0x53, 0, continued ? 1 : 0]);
    // granule position 0 (bytes 6–13), then serial and sequence number
    header.set(u32le(serial), 14);
    header.set(u32le(seq + pages.length), 18);
    header[26] = segs.length;
    segs.forEach((s, k) => (header[27 + k] = s.lace));
    const page = concat([header, ...segs.map((s) => s.data)]);
    page.set(u32le(oggCrc(page)), 22);
    pages.push(page);
  }
  return pages;
}

/** The comment packet: Vorbis («\x03vorbis», framing bit) or Opus («OpusTags»). */
function commentPacket(kind: 'vorbis' | 'opus', vendor: string, fields: [string, string][]): Uint8Array {
  const v = utf8(vendor);
  const parts: Uint8Array[] = [kind === 'vorbis' ? concat([new Uint8Array([3]), utf8('vorbis')]) : utf8('OpusTags'), u32le(v.length), v, u32le(fields.length)];
  for (const [k, value] of fields) {
    const f = utf8(`${k}=${value}`);
    parts.push(u32le(f.length), f);
  }
  if (kind === 'vorbis') parts.push(new Uint8Array([1]));
  return concat(parts);
}

type Merge = (original: [string, string][], tags: Tags, cover: WriteSpec['cover'], mode: WriteSpec['coverMode']) => [string, string][];

export async function oggLayout(read: Read, size: number, spec: WriteSpec, merge: Merge): Promise<Layout> {
  let chunk = 64 * 1024;
  for (;;) {
    const b = await read(0, Math.min(size, chunk));
    const pages: Page[] = [];
    const packets: Uint8Array[] = [];
    let current: Uint8Array[] = [];
    let at = 0;
    let serial = -1;
    let kind: 'vorbis' | 'opus' | null = null;
    let need = 3;
    let headerEnd = -1;
    while (packets.length < need) {
      const p = parsePage(b, at);
      if (!p) break;
      if (serial === -1) serial = p.serial;
      if (p.serial === serial) {
        pages.push(p);
        let data = p.body;
        for (const l of p.lacing) {
          current.push(b.subarray(data, data + l));
          data += l;
          if (l < 255) {
            packets.push(concat(current));
            current = [];
            if (packets.length === 1) {
              const first = packets[0];
              if (first[0] === 1 && String.fromCharCode(...first.subarray(1, 7)) === 'vorbis') kind = 'vorbis';
              else if (String.fromCharCode(...first.subarray(0, 8)) === 'OpusHead') {
                kind = 'opus';
                need = 2;
              } else throw new Error('Ogg stream is neither Vorbis nor Opus');
            }
          }
        }
        if (packets.length > need) throw new Error('Ogg header pages carry audio');
        if (packets.length === need && current.length === 0) headerEnd = p.end;
      }
      at = p.end;
    }
    if (headerEnd < 0) {
      if (chunk >= size || chunk >= 64 * 1024 * 1024) throw new Error('Ogg header not found');
      chunk *= 4;
      continue;
    }
    // The comment packet: the file's fields merged with the row's; the cover as a picture field.
    const comment = packets[1];
    const body = kind === 'vorbis' ? comment.subarray(7) : comment.subarray(8);
    const vendorLength = u32(body, 0);
    const vendor = new TextDecoder().decode(body.subarray(4, 4 + vendorLength));
    let fields = merge(parseVorbisComment(body), spec.tags, spec.cover, spec.coverMode);
    if (spec.cover) {
      const block = pictureBlock(spec.cover.image, spec.cover.mime);
      let text = '';
      for (let i = 0; i < block.length; i += 0x8000) text += String.fromCharCode(...block.subarray(i, i + 0x8000));
      fields = [...fields, ['METADATA_BLOCK_PICTURE', btoa(text)]];
    }
    const headerPages = paginate([commentPacket(kind!, vendor, fields), ...packets.slice(2, need)], serial, 1);
    const oldCount = pages.length - 1; // the pages after the first (identification) one
    const delta = headerPages.length - oldCount;
    const first = b.slice(pages[0].start, pages[0].end);
    return {
      parts: [first, ...headerPages, { offset: headerEnd, length: size - headerEnd, ...(delta ? { ogg: { serial, delta } } : {}) }],
      mime: kind === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/ogg',
    };
  }
}

/** A stream of Ogg pages with the sequence numbers of one stream moved by `delta` (checksums redone). */
export function renumberOgg(serial: number, delta: number): TransformStream<Uint8Array, Uint8Array> {
  let buffer: Uint8Array = new Uint8Array(0);
  return new TransformStream({
    transform(chunk, controller) {
      buffer = buffer.length ? concat([buffer, chunk]) : chunk;
      let at = 0;
      for (;;) {
        const p = parsePage(buffer, at);
        if (!p) break;
        const page = buffer.slice(p.start, p.end);
        if (p.serial === serial) {
          page.set(u32le((p.seq + delta) >>> 0), 18);
          page.set(u32le(oggCrc(page)), 22);
        }
        controller.enqueue(page);
        at = p.end;
      }
      buffer = buffer.slice(at);
      if (buffer.length > 70000 && !(buffer[0] === 0x4f && buffer[1] === 0x67)) {
        // Not a page boundary any more (damaged file): pass the rest through as it is.
        controller.enqueue(buffer);
        buffer = new Uint8Array(0);
      }
    },
    flush(controller) {
      if (buffer.length) controller.enqueue(buffer);
    },
  });
}
