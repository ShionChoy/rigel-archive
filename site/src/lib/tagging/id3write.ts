// An ID3v2.4 tag (UTF-8) for an MP3 or a WAV's id3 chunk: the file's own frames, less the ones the row
// sets or removes, plus the row's tags. Frames the site has no tag for (PRIV, GEOB, TLEN, other pictures …)
// stay as they were; v2.3-only frames become their v2.4 counterparts (TYER → TDRC, TORY → TDOR, IPLS → TIPL).

import { concat, imageSize, utf8 } from './bytes';
import type { Id3Frame } from './id3';
import { PERFORMER, TAG_DEF, id3Tag, type Tags } from './names';

const FRONT_COVER = 3;
const syncsafe = (n: number) => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const Z = new Uint8Array([0]);

function frame(id: string, body: Uint8Array): Uint8Array {
  return concat([utf8(id), syncsafe(body.length), new Uint8Array([0, 0]), body]);
}

/** Terminated strings of a frame body (encoding byte first), for reading the original's frames. */
function strings(b: Uint8Array, at: number, encoding: number): string[] {
  const wide = encoding === 1 || encoding === 2;
  const step = wide ? 2 : 1;
  const out: string[] = [];
  let start = at;
  const decode = (bytes: Uint8Array) => {
    if (encoding === 0) return String.fromCharCode(...bytes);
    if (encoding === 3) return new TextDecoder().decode(bytes);
    if (encoding === 1) return new TextDecoder(bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le').decode(bytes).replace(/^﻿/, '');
    return new TextDecoder('utf-16be').decode(bytes);
  };
  for (let i = at; i + step <= b.length; i += step) {
    if (wide ? b[i] === 0 && b[i + 1] === 0 : b[i] === 0) {
      out.push(decode(b.subarray(start, i)));
      start = i + step;
    }
  }
  if (start < b.length) out.push(decode(b.subarray(start)));
  return out;
}

const firstString = (b: Uint8Array, at: number, encoding: number) => strings(b, at, encoding)[0] ?? '';

function textFrame(id: string, values: string[]): Uint8Array {
  return frame(id, concat([new Uint8Array([3]), utf8(values.join('\u0000'))]));
}

function pairsFrame(id: string, pairs: [string, string][]): Uint8Array {
  return frame(id, concat([new Uint8Array([3]), utf8(pairs.flat().join('\u0000'))]));
}

/** The tag names an original frame stands for (a TIPL / TMCL frame stands for each of its roles). */
function frameTags(f: Id3Frame): string[] {
  const b = f.body;
  if (f.id === 'TXXX') {
    const t = id3Tag('TXXX', firstString(b, 1, b[0]));
    return t ? [t] : [];
  }
  if (f.id === 'COMM') return firstString(b, 4, b[0]) ? [] : ['comment']; // described comments (iTunNORM …) are machine data
  if (f.id === 'USLT') return ['lyrics'];
  if (f.id === 'UFID') {
    const t = id3Tag('UFID', firstString(b, 0, 0));
    return t ? [t] : [];
  }
  if (f.id === 'TRCK') return ['tracknumber', 'totaltracks'];
  if (f.id === 'TPOS') return ['discnumber', 'totaldiscs'];
  const t = id3Tag(f.id);
  return t ? [t] : [];
}

export interface Id3Input {
  original: Id3Frame[]; // the file's own frames (readId3Frames)
  tags: Tags; // the row's overrides, number tags included
  cover: { image: Uint8Array; mime: string } | null;
  coverMode: 'replace' | 'add';
}

/** The frames of the new tag, in order: the row's, then the original's that stay. */
export function id3Frames(input: Id3Input): Uint8Array[] {
  const { tags } = input;
  const set = (name: string) => name in tags;
  const frames: Uint8Array[] = [];
  const tipl: [string, string][] = [];
  const tmcl: [string, string][] = [];

  // The original's frames that stay.
  const kept: Uint8Array[] = [];
  for (const f of input.original) {
    const b = f.body;
    if (f.id === 'TIPL' || f.id === 'IPLS' || f.id === 'TMCL') {
      const list = strings(b, 1, b[0]);
      for (let i = 0; i + 1 < list.length; i += 2) {
        const name = f.id === 'TMCL' ? `${PERFORMER}${list[i]}` : id3Tag('TIPL', list[i]);
        if (name && set(name)) continue;
        (f.id === 'TMCL' ? tmcl : tipl).push([list[i], list[i + 1]]);
      }
      continue;
    }
    if (f.id === 'TYER' || f.id === 'TORY') {
      // v2.3 years: kept as the v2.4 date when the row does not set one.
      const name = f.id === 'TYER' ? 'date' : 'originaldate';
      if (!set(name) && !input.original.some((o) => o.id === (f.id === 'TYER' ? 'TDRC' : 'TDOR'))) kept.push(frame(f.id === 'TYER' ? 'TDRC' : 'TDOR', b));
      continue;
    }
    if (['TDAT', 'TIME', 'TRDA', 'TSIZ', 'RVAD', 'EQUA'].includes(f.id)) continue;
    if (f.id === 'APIC' && input.cover && input.coverMode === 'replace' && b[firstString(b, 1, 0).length + 2] === FRONT_COVER) continue;
    const names = frameTags(f);
    if (names.some(set)) continue;
    kept.push(frame(f.id, b));
  }

  // The row's tags.
  const num = (n: string, total: string) => {
    const a = tags[n]?.[0];
    const t = tags[total]?.[0];
    return a ? `${a}${t ? `/${t}` : ''}` : '';
  };
  for (const [name, values] of Object.entries(tags)) {
    if (values.length === 0) continue;
    if (name === 'tracknumber' || name === 'discnumber') {
      const v = num(name, name === 'tracknumber' ? 'totaltracks' : 'totaldiscs');
      if (v) frames.push(textFrame(name === 'tracknumber' ? 'TRCK' : 'TPOS', [v]));
      continue;
    }
    if (name === 'totaltracks' || name === 'totaldiscs') continue;
    if (name.startsWith(PERFORMER)) {
      for (const v of values) tmcl.push([name.slice(PERFORMER.length), v]);
      continue;
    }
    const spec = TAG_DEF.get(name)?.id3 ?? `TXXX:${name}`;
    if (spec.startsWith('TXXX:')) {
      frames.push(frame('TXXX', concat([new Uint8Array([3]), utf8(spec.slice(5)), Z, utf8(values.join('\u0000'))])));
    } else if (spec.startsWith('TIPL:')) {
      for (const v of values) tipl.push([spec.slice(5), v]);
    } else if (spec === 'COMM' || spec === 'USLT') {
      frames.push(frame(spec, concat([new Uint8Array([3]), utf8('und'), Z, utf8(values.join('\n'))])));
    } else if (spec.startsWith('UFID:')) {
      frames.push(frame('UFID', concat([utf8(spec.slice(5)), Z, utf8(values[0])])));
    } else if (spec.startsWith('W')) {
      frames.push(frame(spec, new TextEncoder().encode(values[0])));
    } else if (spec === 'TCMP') {
      frames.push(textFrame(spec, [values[0] === '0' ? '0' : '1']));
    } else frames.push(textFrame(spec, values));
  }
  if (tipl.length) frames.push(pairsFrame('TIPL', tipl));
  if (tmcl.length) frames.push(pairsFrame('TMCL', tmcl));
  if (input.cover) {
    const mime = imageSize(input.cover.image)?.mime ?? input.cover.mime;
    frames.push(frame('APIC', concat([new Uint8Array([3]), utf8(mime), Z, new Uint8Array([FRONT_COVER]), Z, input.cover.image])));
  }
  return [...frames, ...kept];
}

/** A whole ID3v2.4 tag (header, frames, some padding for later edits). */
export function buildId3(input: Id3Input, padding = 1024): Uint8Array {
  const body = concat([...id3Frames(input), new Uint8Array(padding)]);
  return concat([utf8('ID3'), new Uint8Array([4, 0, 0]), syncsafe(body.length), body]);
}
