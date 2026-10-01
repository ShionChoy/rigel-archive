// Where the admin reads a file's bytes: storage when the content is there (uploads, and 合辑 files
// after `ra push`); in local development otherwise `uv run ra serve` (MEDIA_DEV_BASE), by content when
// hashed (also finds unpacked archive members), else by path in the 合辑.
//
// For playing and previewing, the derived files (stream FLAC, AAC, WebP, MP4) come first when the
// processing program has made them; the original is the fallback.
//
// The public site reads the same stored objects through its own signed addresses (lib/public/media.ts):
// the helpers below take the addresses to use (MediaUrls), the admin's by default.

import type { FileRow } from './db';
import type { DerivedRow } from './processing';

export type MediaFile = Pick<FileRow, 'name' | 'source_path' | 'member_path' | 'sha256' | 'blob_key'>;
export type Derived = Map<string, DerivedRow> | undefined;

/** How a page addresses stored objects: the admin's /admin/media, or the public site's signed /media. */
export interface MediaUrls {
  /** A stored object by its key (blobs/…, derived/…, pictures/…); `lasting` for pictures, else for playing or reading. */
  object(key: string, lasting: boolean): string | null;
  /** The original of a file, where it can be read from (null: nowhere). */
  original(file: MediaFile, lasting: boolean): string | null;
  /** Large pictures by their originals too (the admin); the public site shows those by their previews. */
  fullPictures?: boolean;
}

/** The admin's addresses: stored objects under /admin/media, else `uv run ra serve` in local development. */
export function adminUrls(base: string): MediaUrls {
  return {
    object: (key) => `/admin/media/${key}`,
    original: (file) => mediaSrc(file, base),
    fullPictures: true,
  };
}

export const ADMIN_URLS = adminUrls('');

/** Derived kinds that are pictures (addressed for good); the others are played (addressed for a while). */
const PICTURE_KINDS = new Set(['img240', 'img640', 'img1600', 'poster', 'embed']);

export function mediaSrc(file: MediaFile, base: string): string | null {
  if (file.blob_key) return `/admin/media/${file.blob_key}`;
  const root = base.replace(/\/$/, '');
  if (!root) return null;
  if (file.sha256) return `${root}/blob/${file.sha256}/${encodeURIComponent(file.name)}`;
  if (file.source_path && !file.member_path) return `${root}/source/${file.source_path.split('/').map(encodeURIComponent).join('/')}`;
  return null;
}

export const derivedUrl = (row: DerivedRow | undefined, urls: MediaUrls) => (row ? urls.object(row.key, PICTURE_KINDS.has(row.kind)) : null);

export interface Source {
  src: string; // '' when locked
  type: string;
  label?: string; // «FLAC 24 bit / 48 kHz», «AAC 192 kbps» (what the player shows)
  lossless?: boolean;
  /** The public site's versions of a track (lib/playback.ts): 无损 (the stream), 原件, 省流. */
  kind?: 'lossless' | 'original' | 'lossy';
  size?: number | null;
  /** Lossless: sounds exactly like the original, sample for sample. */
  same?: boolean;
  /** Listed but not open here (beyond the edition's or file's quality cap). */
  locked?: boolean;
  /** A preview clip: the part of the track it is, in seconds. */
  span?: [number, number];
}

interface SoundInfo { codec?: string; bits?: number; rate?: number; kbps?: number; lossless?: boolean }

export const info = (row: DerivedRow | undefined): SoundInfo => {
  try {
    return row?.info ? (JSON.parse(row.info) as SoundInfo) : {};
  } catch {
    return {};
  }
};

/** «FLAC 24 bit / 48 kHz» for lossless sound, «MP3 320 kbps» for the rest. */
export function soundLabel(name: string, i: SoundInfo): string {
  const rate = i.rate ? `${+(i.rate / 1000).toFixed(1)} kHz` : '';
  return i.lossless || name === 'FLAC' || name === 'WAV'
    ? [name, i.bits ? `${i.bits} bit` : '', rate].filter(Boolean).join(' ').replace(/ bit (\d)/, ' bit / $1')
    : [name, i.kbps ? `${i.kbps} kbps` : ''].filter(Boolean).join(' ');
}

/** Audio sources, best first: lossless stream, AAC, then the original (`original` also describes it when known). */
export function audioSources(
  original: string | null, derived: Derived, originalType: string, urls: MediaUrls = ADMIN_URLS, originalInfo?: SoundInfo & { ext?: string },
): Source[] {
  const out: Source[] = [];
  const streamRow = derived?.get('stream');
  const aacRow = derived?.get('aac');
  const stream = derivedUrl(streamRow, urls);
  const aac = derivedUrl(aacRow, urls);
  if (stream) out.push({ src: stream, type: 'audio/flac', label: soundLabel('FLAC', info(streamRow)), lossless: true });
  if (aac) out.push({ src: aac, type: 'audio/mp4', label: soundLabel('AAC', info(aacRow)), lossless: false });
  if (original && !out.some((s) => s.src === original)) {
    const name = (originalInfo?.ext ?? '').toUpperCase();
    out.push({ src: original, type: originalType, ...(originalInfo && name ? { label: soundLabel(name, originalInfo), lossless: !!originalInfo.lossless } : {}) });
  }
  return out;
}

/** The picture to show for an image: the largest WebP preview up to the wanted size, else the original. */
export function imageSrc(original: string | null, derived: Derived, size: 240 | 640 | 1600 = 1600, urls: MediaUrls = ADMIN_URLS): string | null {
  const order = size === 240 ? ['img240', 'img640', 'img1600'] : size === 640 ? ['img640', 'img1600', 'img240'] : ['img1600', 'img640', 'img240'];
  for (const kind of order) {
    const src = derivedUrl(derived?.get(kind), urls);
    if (src) return src;
  }
  return original;
}

/** A picture carried inside audio files (pictures/<sha256>): its WebP preview up to the wanted size, else itself. */
export function pictureSrc(sha256: string, derived: Derived, size: 240 | 640 | 1600 = 640, urls: MediaUrls = ADMIN_URLS): string | null {
  return imageSrc(urls.object(`pictures/${sha256}`, true), derived, size, urls);
}

export function videoSources(original: string | null, derived: Derived, originalType: string, urls: MediaUrls = ADMIN_URLS): { sources: Source[]; poster: string | null } {
  const sources: Source[] = [];
  const video = derivedUrl(derived?.get('video'), urls);
  if (video) sources.push({ src: video, type: 'video/mp4' });
  if (original) sources.push({ src: original, type: originalType });
  return { sources, poster: derivedUrl(derived?.get('poster'), urls) };
}

export const waveSrc = (derived: Derived) => derivedUrl(derived?.get('wave'), ADMIN_URLS);
