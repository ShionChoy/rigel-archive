// MP4 / M4A with new tags: the iTunes item list (moov/udta/meta/ilst) is rebuilt; everything else in moov
// stays. When moov comes before the media data, the chunk offsets (stco / co64) move by the change in
// moov's size so they still point at the same audio.

import { concat, imageSize, utf8 } from './bytes';
import { TAG_DEF, mp4Tag, type Tags } from './names';
import type { Read } from './read';
import type { Layout, WriteSpec } from './write';

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const typeOf = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at + 4, at + 8));

interface Atom {
  type: string;
  start: number;
  body: number;
  end: number;
}

function atoms(b: Uint8Array, from: number, to: number): Atom[] {
  const out: Atom[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let body = at + 8;
    if (size === 1) {
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    out.push({ type: typeOf(b, at), start: at, body, end: at + size });
    at += size;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([be32(body.length + 8), latin1(type), body]);
}

function data(kind: number, payload: Uint8Array): Uint8Array {
  return box('data', be32(kind), be32(0), payload);
}

/** The tag an item atom stands for (freeform ones by their name). */
function itemTag(b: Uint8Array, item: Atom): string | null {
  if (item.type === '----') {
    const name = atoms(b, item.body, item.end).find((a) => a.type === 'name');
    return mp4Tag(`----:${name ? new TextDecoder().decode(b.subarray(name.body + 4, name.end)) : ''}`);
  }
  if (item.type === 'trkn') return 'tracknumber';
  if (item.type === 'disk') return 'discnumber';
  if (item.type === 'gnre') return 'genre';
  return mp4Tag(item.type);
}

function items(tags: Tags, cover: WriteSpec['cover']): Uint8Array[] {
  const out: Uint8Array[] = [];
  const pair = (n: string, total: string, atom: string) => {
    const a = Number(tags[n]?.[0] ?? 0) || 0;
    const t = Number(tags[total]?.[0] ?? 0) || 0;
    if (a || t) out.push(box(atom, data(0, new Uint8Array([0, 0, a >> 8, a & 255, t >> 8, t & 255, ...(atom === 'trkn' ? [0, 0] : [])]))));
  };
  if (tags.tracknumber?.length || tags.totaltracks?.length) pair('tracknumber', 'totaltracks', 'trkn');
  if (tags.discnumber?.length || tags.totaldiscs?.length) pair('discnumber', 'totaldiscs', 'disk');
  for (const [name, values] of Object.entries(tags)) {
    if (!values.length || ['tracknumber', 'totaltracks', 'discnumber', 'totaldiscs'].includes(name)) continue;
    const spec = TAG_DEF.get(name)?.mp4 ?? `----:${name.toUpperCase()}`;
    if (spec === 'tmpo') {
      const n = Math.max(0, Math.min(65535, Math.round(Number(values[0]) || 0)));
      out.push(box('tmpo', data(21, new Uint8Array([n >> 8, n & 255]))));
    } else if (spec === 'cpil') {
      out.push(box('cpil', data(21, new Uint8Array([values[0] === '0' ? 0 : 1]))));
    } else if (spec.startsWith('----:')) {
      out.push(box('----', box('mean', be32(0), utf8('com.apple.iTunes')), box('name', be32(0), utf8(spec.slice(5))), ...values.map((v) => data(1, utf8(v)))));
    } else {
      out.push(box(spec, ...values.map((v) => data(1, utf8(v)))));
    }
  }
  if (cover) {
    const mime = imageSize(cover.image)?.mime ?? cover.mime;
    out.push(box('covr', data(mime === 'image/png' ? 14 : 13, cover.image)));
  }
  return out;
}

/** Add `delta` to every chunk offset (stco, co64) after `from` in a moov's tracks. */
function shiftOffsets(m: Uint8Array, from: number, delta: number) {
  const walk = (start: number, end: number) => {
    for (const a of atoms(m, start, end)) {
      if (['trak', 'mdia', 'minf', 'stbl'].includes(a.type)) walk(a.body, a.end);
      else if (a.type === 'stco' || a.type === 'co64') {
        const n = u32(m, a.body + 4);
        const wide = a.type === 'co64';
        for (let i = 0; i < n; i += 1) {
          const at = a.body + 8 + i * (wide ? 8 : 4);
          const v = wide ? u32(m, at) * 2 ** 32 + u32(m, at + 4) : u32(m, at);
          if (v < from) continue;
          const next = v + delta;
          if (wide) {
            m.set(be32(Math.floor(next / 2 ** 32)), at);
            m.set(be32(next % 2 ** 32), at + 4);
          } else {
            if (next >= 2 ** 32) throw new Error('chunk offset overflow');
            m.set(be32(next), at);
          }
        }
      }
    }
  };
  walk(8, m.length);
}

export async function mp4Layout(read: Read, size: number, spec: WriteSpec): Promise<Layout> {
  let at = 0;
  let moov: { start: number; size: number } | null = null;
  let firstMdat = -1;
  for (let guard = 0; guard < 200 && at + 8 <= size; guard += 1) {
    const h = await read(at, 16);
    let len = u32(h, 0);
    if (len === 1) len = u32(h, 8) * 2 ** 32 + u32(h, 12);
    else if (len === 0) len = size - at;
    if (len < 8) break;
    const type = typeOf(h, 0);
    if (type === 'moov') moov = { start: at, size: len };
    if (type === 'mdat' && firstMdat < 0) firstMdat = at;
    at += len;
  }
  if (!moov || moov.size > 64 * 1024 * 1024) throw new Error('no moov atom');
  const m = await read(moov.start, moov.size);
  if (u32(m, 0) === 1) throw new Error('64-bit moov size');
  const kids = atoms(m, 8, m.length);
  const udta = kids.find((a) => a.type === 'udta');
  const udtaKids = udta ? atoms(m, udta.body, udta.end) : [];
  const meta = udtaKids.find((a) => a.type === 'meta');
  const plain = meta ? ['hdlr', 'ilst', 'free'].includes(typeOf(m, meta.body)) : false;
  const metaBody = meta ? meta.body + (plain ? 0 : 4) : 0;
  const metaKids = meta ? atoms(m, metaBody, meta.end) : [];
  const ilst = metaKids.find((a) => a.type === 'ilst');
  // The item list: the file's own items the row does not set, then the row's.
  const kept: Uint8Array[] = [];
  for (const item of ilst ? atoms(m, ilst.body, ilst.end) : []) {
    const tag = itemTag(m, item);
    if (item.type === 'covr') {
      if (spec.cover && spec.coverMode === 'replace') continue;
    } else if (tag && (tag in spec.tags || (tag === 'tracknumber' && 'totaltracks' in spec.tags) || (tag === 'discnumber' && 'totaldiscs' in spec.tags))) continue;
    kept.push(m.slice(item.start, item.end));
  }
  const newIlst = box('ilst', ...items(spec.tags, spec.cover), ...kept);
  const hdlr = metaKids.find((a) => a.type === 'hdlr');
  const newMeta = box('meta', new Uint8Array(4),
    hdlr ? m.slice(hdlr.start, hdlr.end) : box('hdlr', new Uint8Array(8), latin1('mdirappl'), new Uint8Array(9)),
    ...metaKids.filter((a) => a.type !== 'hdlr' && a.type !== 'ilst' && a.type !== 'free').map((a) => m.slice(a.start, a.end)),
    newIlst);
  const newUdta = box('udta', ...udtaKids.filter((a) => a.type !== 'meta').map((a) => m.slice(a.start, a.end)), newMeta);
  const newMoov = box('moov', ...kids.filter((a) => a.type !== 'udta').map((a) => m.slice(a.start, a.end)), newUdta);
  const delta = newMoov.length - moov.size;
  // Media data after moov moves by delta; offsets into data before it stay.
  if (delta !== 0 && firstMdat > moov.start) shiftOffsets(newMoov, moov.start + moov.size, delta);
  const end = moov.start + moov.size;
  return {
    parts: [
      ...(moov.start > 0 ? [{ offset: 0, length: moov.start }] : []),
      newMoov,
      ...(end < size ? [{ offset: end, length: size - end }] : []),
    ],
    mime: 'audio/mp4',
  };
}
