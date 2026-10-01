// 播放版本 (设计文档「文件权限方案 · 播放版本与原件」): the versions of a track visitors may choose in the
// player, by the file's access (lib/access.ts).
//
//   无损 lossless   the stream FLAC the processing program made (sounds exactly like a lossless original)
//   原件 original   the file as it was collected (a WAV, a FLAC with its pictures, an MP3 …)
//   省流 lossy      the AAC copy
//
// The player plays 无损 unless the visitor picks another (kept in their browser). Versions beyond the quality
// cap are listed without an address, so the menu can say they are not open here. When the stream is the
// original itself (most FLACs) there is one version, 原件. A track set to a preview clip offers the clip only.

import { mimeFor } from './constants';
import { parseFormat } from './db';
import { QUALITY_RANK, clipSpan, type Access, type Quality } from './access';
import { derivedUrl, info, soundLabel, type Derived, type MediaFile, type MediaUrls, type Source } from './media';

export type Playable = MediaFile & { ext: string; format: string | null; size: number };

/** A preview clip the processing program cut (table clips, phase 2): its stored versions. */
export interface ClipFile { kind: 'lossless' | 'lossy'; key: string; size: number; info: string | null; from: number; to: number }

/** Lossless sound formats as stored: a version of one of these is the original's sound exactly. */
const LOSSLESS_EXT = /^(wav|flac|aiff?|wv|ape|tta|alac)$/i;

/**
 * The versions of `file` visitors may choose, 无损 · 原件 · 省流 in that order; those beyond the quality cap
 * are locked (no address). Empty when the access does not play it, or a clip is wanted and not cut yet.
 */
export function playVersions(file: Playable, derived: Derived, access: Pick<Access, 'play' | 'quality' | 'clip'>, urls: MediaUrls, clips: ClipFile[] = []): Source[] {
  if (access.play === 'none') return [];
  const fmt = parseFormat(file.format);
  if (access.play === 'clip') {
    const span = clipSpan(access.clip, fmt.duration ?? null);
    const mine = clips.filter((c) => Math.abs(c.from - span.from) < 0.01 && Math.abs(c.to - span.to) < 0.01);
    return mine
      .sort((a, b) => (a.kind === 'lossless' ? -1 : 1) - (b.kind === 'lossless' ? -1 : 1))
      .map((c): Source => {
        const allowed = QUALITY_RANK[c.kind] <= QUALITY_RANK[access.quality];
        const row = { sha256: '', kind: c.kind === 'lossless' ? 'clip_flac' : 'clip_aac', key: c.key, size: c.size, info: c.info };
        return {
          src: allowed ? urls.object(c.key, false) ?? '' : '',
          type: c.kind === 'lossless' ? 'audio/flac' : 'audio/mp4',
          label: soundLabel(c.kind === 'lossless' ? 'FLAC' : 'AAC', info(row)),
          lossless: c.kind === 'lossless', kind: c.kind, size: c.size, span: [c.from, c.to],
          ...(allowed ? {} : { locked: true }),
        };
      })
      .filter((s) => s.src || s.locked);
  }

  const originalLossless = !!fmt.lossless || LOSSLESS_EXT.test(file.ext);
  const stream = derived?.get('stream');
  const aac = derived?.get('aac');
  const streamIsOriginal = !!stream && !!file.blob_key && stream.key === file.blob_key;
  const out: (Source & { level: Quality })[] = [];
  if (stream && !streamIsOriginal) {
    out.push({ src: derivedUrl(stream, urls) ?? '', type: 'audio/flac', label: soundLabel('FLAC', info(stream)), lossless: true, kind: 'lossless', size: stream.size, same: originalLossless, level: 'lossless' });
  }
  const original = urls.original(file, false);
  if (original) {
    const name = (file.ext || fmt.codec || '').toUpperCase();
    out.push({
      src: original, type: mimeFor(file.ext), label: soundLabel(name, { ...fmt, lossless: originalLossless }), lossless: originalLossless, kind: 'original', size: file.size,
      // The stream that is the original itself counts as 无损; a lossy original is as open as 省流.
      level: streamIsOriginal ? 'lossless' : originalLossless ? 'original' : 'lossy',
    });
  }
  if (aac) out.push({ src: derivedUrl(aac, urls) ?? '', type: 'audio/mp4', label: soundLabel('AAC', info(aac)), lossless: false, kind: 'lossy', size: aac.size, level: 'lossy' });
  return out
    .filter((v) => v.src)
    .map(({ level, ...v }) => (QUALITY_RANK[level] <= QUALITY_RANK[access.quality] ? v : { ...v, src: '', locked: true }));
}

/** Versions with an address: what can be played here. */
export const openVersions = (list: Source[] | null | undefined) => (list ?? []).filter((s) => s.src && !s.locked);
