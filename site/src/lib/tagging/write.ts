// A file with new tags, described as the parts it is made of: new bytes (headers, tags) and ranges of the
// stored original (the audio, streamed unchanged). FLAC and Ogg get new Vorbis comments, MP3 a new ID3v2.4
// tag, WAV a new RIFF INFO list and id3 chunk (it stays WAV), MP4 / M4A a new iTunes item list. What the
// file carries and the row does not set stays as it was; the audio is never touched (an Ogg file whose
// header pages change in number gets its later pages renumbered, see ogg.ts).

import { concat, u32le, utf8 } from './bytes';
import { flacHeader, pictureBlock, pictureType as parsePictureType, readFlacLayout, vorbisComment } from './flac';
import { mp3AudioRange, readId3Frames } from './id3';
import { buildId3 } from './id3write';
import { mp4Layout } from './mp4';
import { PERFORMER, TAG_DEF, splitPerformer, vorbisField, vorbisTag, riffTag, type Tags } from './names';
import { oggLayout } from './ogg';
import { legacyText, readEmbedded, type Read } from './read';

export type Part = Uint8Array | { offset: number; length: number; ogg?: { serial: number; delta: number } };

export interface WriteSpec {
  tags: Tags; // the row's overrides, with the number tags
  cover: { image: Uint8Array; mime: string } | null;
  coverMode: 'replace' | 'add';
  /**
   * The original's own pictures, for a file made from another stored object that has none (a WAV or AIFF
   * downloaded as FLAC is made from its stream FLAC, which leaves pictures out): written as they were.
   */
  pictures?: { image: Uint8Array; mime: string; type: number; description: string }[];
}

export interface Layout {
  parts: Part[];
  mime: string;
}

export const partLength = (p: Part) => (p instanceof Uint8Array ? p.length : p.length);
export const layoutLength = (l: Layout) => l.parts.reduce((n, p) => n + partLength(p), 0);

// ------------------------------------------------------------------------------------------ Vorbis comments

/** The file's fields less the ones the row sets or removes, then the row's. */
export function mergeVorbis(original: [string, string][], tags: Tags, cover: WriteSpec['cover'], coverMode: WriteSpec['coverMode']): [string, string][] {
  const kept = original.filter(([k, v]) => {
    const key = k.toUpperCase();
    if (key === 'METADATA_BLOCK_PICTURE') {
      if (!cover || coverMode === 'add') return true;
      try {
        return parsePictureType(Uint8Array.from(atob(v.trim()), (c) => c.charCodeAt(0))) !== 3;
      } catch {
        return true;
      }
    }
    if (key === 'COVERART' || key === 'COVERARTMIME') return !cover || coverMode === 'add';
    const tag = vorbisTag(k);
    if (tag === 'performer') return !(`${PERFORMER}${splitPerformer(v)[0] || 'performer'}` in tags);
    return !(tag in tags);
  });
  const added: [string, string][] = [];
  for (const [name, values] of Object.entries(tags)) {
    for (const v of values) {
      if (name.startsWith(PERFORMER)) added.push(['PERFORMER', `${v} (${name.slice(PERFORMER.length)})`]);
      else added.push([vorbisField(name), v]);
    }
  }
  return [...added, ...kept];
}

async function flacLayout(read: Read, size: number, spec: WriteSpec): Promise<Layout> {
  const layout = await readFlacLayout(read);
  const fields = mergeVorbis(layout.comments, spec.tags, null, spec.coverMode);
  let pictures = layout.pictures.length ? layout.pictures : (spec.pictures ?? []).map((p) => pictureBlock(p.image, p.mime, p.type, p.description));
  if (spec.cover) {
    const hasFront = pictures.some((p) => parsePictureType(p) === 3);
    pictures = spec.coverMode === 'replace'
      ? [pictureBlock(spec.cover.image, spec.cover.mime), ...pictures.filter((p) => parsePictureType(p) !== 3)]
      : [...pictures, pictureBlock(spec.cover.image, spec.cover.mime, hasFront ? 0 : 3)];
  }
  const header = flacHeader(layout, vorbisComment(fields), pictures);
  return { parts: [header, { offset: layout.audioOffset, length: size - layout.audioOffset }], mime: 'audio/flac' };
}

// ------------------------------------------------------------------------------------------ MP3

async function mp3Layout(read: Read, size: number, spec: WriteSpec): Promise<Layout> {
  const range = await mp3AudioRange(size, read);
  const original = range.start > 0 ? await readId3Frames(read) : [];
  // A file with only ID3v1 / APEv2 (dropped with the audio range) keeps their values in the new tag.
  let tags = spec.tags;
  if (original.length === 0) {
    const own = await readEmbedded(read, size, 'mp3');
    tags = { ...own.tags, ...spec.tags };
  }
  const header = buildId3({ original, tags, cover: spec.cover, coverMode: spec.coverMode });
  return { parts: [header, { offset: range.start, length: range.end - range.start }], mime: 'audio/mpeg' };
}

// ------------------------------------------------------------------------------------------ WAV

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const LARGE = 16 * 1024 * 1024;

function chunk(id: string, body: Uint8Array): Uint8Array {
  return concat([utf8(id), u32le(body.length), body, body.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

async function wavLayout(read: Read, size: number, spec: WriteSpec): Promise<Layout> {
  const h = await read(0, 12);
  if (ascii(h, 0, 4) !== 'RIFF' || ascii(h, 8, 4) !== 'WAVE') throw new Error('not a WAV file');
  const parts: Part[] = [];
  let info: [string, string][] = [];
  let frames: Awaited<ReturnType<typeof readId3Frames>> = [];
  let at = 12;
  for (let guard = 0; guard < 500 && at + 8 <= size; guard += 1) {
    const c = await read(at, 12);
    const id = ascii(c, 0, 4);
    const len = u32(c, 4);
    const end = Math.min(size, at + 8 + len + (len & 1));
    if (id === 'LIST' && ascii(c, 8, 4) === 'INFO') {
      const body = await read(at + 12, len - 4);
      for (let i = 0; i + 8 <= body.length;) {
        const n = u32(body, i + 4);
        let e = i + 8 + n;
        while (e > i + 8 && body[e - 1] === 0) e -= 1;
        info.push([ascii(body, i, 4), legacyText(body.subarray(i + 8, Math.min(e, body.length)))]);
        i += 8 + n + (n & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      frames = await readId3Frames((offset, length) => read(at + 8 + offset, length));
    } else if (id === 'data' || len > LARGE) {
      parts.push(c.slice(0, 8), { offset: at + 8, length: end - at - 8 });
    } else {
      parts.push(await read(at, end - at));
    }
    at = end;
    if (len === 0 && id !== 'data') break;
  }
  // INFO: the file's own entries the row does not set, then the row's (UTF-8).
  const infoTags: Tags = {};
  for (const [id, v] of info) {
    const tag = riffTag(id);
    if (tag && v) (infoTags[tag] ??= []).push(v);
  }
  info = info.filter(([id]) => {
    const tag = riffTag(id);
    return !tag || !(tag in spec.tags);
  });
  for (const [name, values] of Object.entries(spec.tags)) {
    const id = TAG_DEF.get(name)?.riff;
    if (id && values.length) info.push([id, values.join('; ')]);
  }
  const list = concat([utf8('INFO'), ...info.filter(([, v]) => v).map(([id, v]) => chunk(id, concat([utf8(v), new Uint8Array(1)])))]);
  // The id3 chunk: the file's own frames (or, without any, what its INFO said), then the row's tags.
  const id3 = buildId3({ original: frames, tags: frames.length ? spec.tags : { ...infoTags, ...spec.tags }, cover: spec.cover, coverMode: spec.coverMode }, 0);
  parts.push(chunk('LIST', list), chunk('id3 ', id3));
  const total = 12 + parts.reduce((n, p) => n + partLength(p), 0);
  return { parts: [concat([utf8('RIFF'), u32le(total - 8), utf8('WAVE')]), ...parts], mime: 'audio/wav' };
}

// ------------------------------------------------------------------------------------------ all

/** Formats that are written in their own format (a WAV may also be offered as its stream FLAC). */
export const WRITABLE = new Set(['flac', 'mp3', 'wav', 'm4a', 'mp4', 'm4b', 'ogg', 'opus', 'oga']);

export async function taggedLayout(ext: string, read: Read, size: number, spec: WriteSpec): Promise<Layout> {
  const e = ext.toLowerCase();
  if (e === 'flac') return flacLayout(read, size, spec);
  if (e === 'mp3') return mp3Layout(read, size, spec);
  if (e === 'wav') return wavLayout(read, size, spec);
  if (e === 'm4a' || e === 'mp4' || e === 'm4b') return mp4Layout(read, size, spec);
  if (e === 'ogg' || e === 'opus' || e === 'oga') return oggLayout(read, size, spec, mergeVorbis);
  throw new Error(`cannot tag .${e}`);
}
