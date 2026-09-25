// Where the admin reads a file's bytes: storage when the content is there (uploads, and 合辑 files
// after `ra push`); in local development otherwise `uv run ra serve` (MEDIA_DEV_BASE), by content when
// hashed (also finds unpacked archive members), else by path in the 合辑.
//
// For playing and previewing, the derived files (stream FLAC, AAC, WebP, MP4) come first when the
// processing program has made them; the original is the fallback.

import type { FileRow } from './db';
import type { DerivedRow } from './processing';

export type MediaFile = Pick<FileRow, 'name' | 'source_path' | 'member_path' | 'sha256' | 'blob_key'>;
export type Derived = Map<string, DerivedRow> | undefined;

export function mediaSrc(file: MediaFile, base: string): string | null {
  if (file.blob_key) return `/admin/media/${file.blob_key}`;
  const root = base.replace(/\/$/, '');
  if (!root) return null;
  if (file.sha256) return `${root}/blob/${file.sha256}/${encodeURIComponent(file.name)}`;
  if (file.source_path && !file.member_path) return `${root}/source/${file.source_path.split('/').map(encodeURIComponent).join('/')}`;
  return null;
}

const url = (row: DerivedRow | undefined) => (row ? `/admin/media/${row.key}` : null);

export interface Source {
  src: string;
  type: string;
}

/** Audio sources, best first: lossless stream, AAC, then the original. */
export function audioSources(original: string | null, derived: Derived, originalType: string): Source[] {
  const out: Source[] = [];
  const stream = derived?.get('stream');
  const aac = derived?.get('aac');
  if (stream) out.push({ src: url(stream)!, type: 'audio/flac' });
  if (aac) out.push({ src: url(aac)!, type: 'audio/mp4' });
  if (original && !out.some((s) => s.src === original)) out.push({ src: original, type: originalType });
  return out;
}

/** The picture to show for an image: the largest WebP preview up to the wanted size, else the original. */
export function imageSrc(original: string | null, derived: Derived, size: 240 | 640 | 1600 = 1600): string | null {
  const order = size === 240 ? ['img240', 'img640', 'img1600'] : size === 640 ? ['img640', 'img1600', 'img240'] : ['img1600', 'img640', 'img240'];
  for (const kind of order) {
    const row = derived?.get(kind);
    if (row) return url(row);
  }
  return original;
}

export function videoSources(original: string | null, derived: Derived, originalType: string): { sources: Source[]; poster: string | null } {
  const sources: Source[] = [];
  const video = derived?.get('video');
  if (video) sources.push({ src: url(video)!, type: 'video/mp4' });
  if (original) sources.push({ src: original, type: originalType });
  return { sources, poster: url(derived?.get('poster')) };
}

export const waveSrc = (derived: Derived) => url(derived?.get('wave'));
