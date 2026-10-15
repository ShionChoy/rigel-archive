// 正在播放 (scripts/now-playing.ts): what the big view shows of the track playing beyond what the player
// carries — its lyrics, its credits, its cover at full size and its waveform. Asked for by file when the view
// opens: pages/api/track.ts on the public site (public files only), pages/admin/api/track.ts in the admin's
// 预览公开页.
//
// The lyrics are the .lrc file next to the track's file when there is one (lib/sidecar.ts), else its «lyrics»
// tag. The tags are the track's as its edition shows them: the file's own, with the organizers' changes on its
// row of the track list over them (lib/tagging/model.ts effectiveTags), as the album page reads them.

import { parseFormat } from './db';
import { embeddedFor } from './embedded';
import type { T } from './i18n';
import { decodeText, parseLyrics, type Lyrics } from './lyrics';
import { derivedUrl, imageSrc, type Derived, type MediaFile, type MediaUrls } from './media';
import { derivedFor } from './processing';
import { FILED_FILE, PREVIEW_EDGE } from './public/rules';
import { lyricsFileFor, type Named } from './sidecar';
import { effectiveTags, parseTags } from './tagging/model';
import { parseCover } from './tags';

export interface TrackInfo {
  lyrics: Lyrics | null;
  /** The track's artists (the player's own line adds the composer). */
  artist: string;
  /** 作曲 · 作词 · 编曲, those the track has. */
  credits: [string, string][];
  /** The cover at up to 1600 px (the player carries a 640 px one). */
  art: string | null;
  /** Its waveform (peak levels 0–255 of the whole file, tools/ra derive.py), when it has been made. */
  wave: { duration: number; peaks: number[] } | null;
}

/** An audio file as trackInfo needs it. */
export type InfoFile = Named & { id: string; track_id: string | null; sha256: string | null };

/** An .lrc file larger than this is not lyrics. */
const LYRICS_MAX = 256 * 1024;

/**
 * What the 正在播放 view shows of `file`. Files next to it (a picture chosen as its row's cover, an .lrc) are
 * used only when `fileOk` holds for them (SQL on files f joined with editions e: the public rules on the
 * public site).
 */
export async function trackInfo(database: D1Database, media: R2Bucket, file: InfoFile, opts: { t: T; urls: MediaUrls; fileOk: string }): Promise<TrackInfo> {
  const { t, urls } = opts;
  const [row, own, derived, beside] = await Promise.all([
    file.edition_id && file.track_id
      ? database.prepare('SELECT tags, cover FROM edition_tracks WHERE edition_id = ? AND track_id = ?')
        .bind(file.edition_id, file.track_id).first<{ tags: string; cover: string | null }>()
      : Promise.resolve(null),
    file.sha256 ? embeddedFor([file.sha256], database).then((m) => m.get(file.sha256!)) : Promise.resolve(undefined),
    file.sha256 ? derivedFor(database, [file.sha256]).then((m) => m.get(file.sha256!)) : Promise.resolve(undefined),
    file.edition_id
      ? database
        .prepare(
          `SELECT f.name, f.download_name, f.ext, f.edition_id, f.folder_id, f.blob_key, f.size FROM files f JOIN editions e ON e.id = f.edition_id
           WHERE f.edition_id = ? AND f.folder_id IS ? AND lower(f.ext) = 'lrc' AND ${FILED_FILE} AND ${opts.fileOk}`,
        )
        .bind(file.edition_id, file.folder_id)
        .all<Named & { blob_key: string | null; size: number }>()
        .then((r) => r.results)
      : Promise.resolve([]),
  ]);
  const tags = effectiveTags(own?.tags ?? {}, parseTags(row?.tags ?? '{}'));
  const value = (name: string) => (tags[name] ?? []).map((v) => v.trim()).filter(Boolean).join(' / ');
  const credits = ([[t('作曲'), value('composer')], [t('作词'), value('lyricist')], [t('编曲'), value('arranger')]] as [string, string][])
    .filter(([, v]) => v);

  // The lyrics: the .lrc beside the file, else its tag. The waveform comes along (a few KB), so the view
  // needs one request, not two.
  const lrc = lyricsFileFor(file, beside);
  const waveKey = derived?.get('wave')?.key;
  const [lrcText, wave] = await Promise.all([
    lrc?.blob_key && lrc.size <= LYRICS_MAX
      ? media.get(lrc.blob_key).then(async (o) => (o ? decodeText(new Uint8Array(await o.arrayBuffer())) : null))
      : Promise.resolve(null),
    waveKey
      ? media.get(waveKey).then((o) => o?.json<{ duration: number; peaks: number[] }>() ?? null).catch(() => null)
      : Promise.resolve(null),
  ]);
  const lyrics = parseLyrics(lrcText) ?? parseLyrics((tags.lyrics ?? []).join('\n\n'));

  // The cover at full size: the row's chosen one, else the one the file carries. Its 1600 px preview, else
  // the original when it may be shown (covers are rarely larger), else a smaller preview.
  const largest = (original: string | null, d: Derived) => derivedUrl(d?.get('img1600'), urls) ?? original ?? imageSrc(null, d, 1600, urls);
  const chosen = parseCover(row?.cover ?? null);
  let art: string | null = null;
  if (chosen?.file) {
    const image = await database
      .prepare(`SELECT f.name, f.source_path, f.member_path, f.sha256, f.blob_key, f.format FROM files f JOIN editions e ON e.id = f.edition_id
                WHERE f.id = ? AND f.kind = 'image' AND ${opts.fileOk}`)
      .bind(chosen.file)
      .first<MediaFile & { format: string | null }>();
    if (image) {
      const fmt = parseFormat(image.format);
      const small = !!fmt.width && !!fmt.height && Math.max(fmt.width, fmt.height) <= PREVIEW_EDGE;
      const d = image.sha256 ? (await derivedFor(database, [image.sha256])).get(image.sha256) : undefined;
      art = largest(small || urls.fullPictures ? urls.original(image, true) : null, d);
    }
  } else {
    const sha = chosen?.picture ?? own?.cover;
    if (sha) art = largest(urls.object(`pictures/${sha}`, true), (await derivedFor(database, [sha])).get(sha));
  }
  return { lyrics, artist: value('artist'), credits, art, wave: wave && Array.isArray(wave.peaks) ? { duration: wave.duration, peaks: wave.peaks } : null };
}
