// 整理版 downloads: the tags a file gets from the catalog (release, edition, track, credits, MusicBrainz
// ids, cover), written into the file as it downloads. FLAC keeps its audio frames byte for byte; a WAV
// or AIFF is offered as its stream FLAC (identical samples); MP3 gets an ID3v2.4 tag. The original is
// never changed and stays downloadable as it was collected.

import { db, parseFormat, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { parseCredits, parseIds, trackTitle, type EditionTrackView } from './editions';
import { concat } from './tagging/bytes';
import { flacHeader, pictureBlock, readFlacLayout, vorbisComment } from './tagging/flac';
import { id3v24, mp3AudioRange } from './tagging/id3';
import type { ZipEntry } from './tagging/zip';

/** The album artist when a release names none: the era's name (DEZAEMON entries were Inoue⊿'s own). */
const ERA_ARTIST: Record<string, string> = { dezaemon: '井上⊿' };

export interface TagSet {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  track: number | null;
  trackTotal: number | null;
  disc: number | null;
  discTotal: number | null;
  date: string | null;
  catalog: string | null;
  label: string | null;
  composer: string | null;
  lyricist: string | null;
  arranger: string | null;
  mbAlbum: string | null;
  mbReleaseGroup: string | null;
  mbRecording: string | null;
  mbTrack: string | null;
  cover: { key: string; ext: string } | null;
}

export interface TaggedSource {
  file: Pick<FileRow, 'id' | 'name' | 'ext' | 'size' | 'mtime' | 'sha256'>;
  tags: TagSet;
  format: 'flac' | 'mp3';
  key: string; // the stored object the audio comes from (the original, or its stream FLAC)
  size: number;
  name: string; // download name
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

export function albumArtist(release: Pick<ReleaseRow, 'artist' | 'era_id'>, eraName: string): string {
  return release.artist || ERA_ARTIST[release.era_id] || eraName;
}

interface Context {
  release: ReleaseRow;
  eraName: string;
  edition: EditionRow;
  rows: EditionTrackView[];
  cover: { key: string; ext: string } | null;
}

async function context(editionId: string): Promise<Context | null> {
  const database = db();
  const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(editionId).first<EditionRow>();
  if (!edition) return null;
  const [release, rows] = await Promise.all([
    database.prepare('SELECT r.*, e.name AS era_name FROM releases r JOIN eras e ON e.id = r.era_id WHERE r.id = ?').bind(edition.release_id).first<ReleaseRow & { era_name: string }>(),
    database
      .prepare(
        `SELECT et.*, t.title AS entry_title, t.version_label, t.song_id, t.credits, t.duration_ms AS entry_duration, t.external_ids AS entry_ids
         FROM edition_tracks et JOIN tracks t ON t.id = et.track_id WHERE et.edition_id = ? ORDER BY et.disc, et.position`,
      )
      .bind(editionId)
      .all<EditionTrackView>(),
  ]);
  if (!release) return null;
  const coverId = edition.cover_file_id ?? release.cover_file_id;
  const cover = coverId
    ? await database.prepare("SELECT blob_key, ext FROM files WHERE id = ? AND blob_key IS NOT NULL AND lower(ext) IN ('jpg', 'jpeg', 'png') AND size < 12000000").bind(coverId).first<{ blob_key: string; ext: string }>()
    : null;
  return { release, eraName: release.era_name, edition, rows: rows.results, cover: cover ? { key: cover.blob_key, ext: cover.ext } : null };
}

export function tagSet(ctx: Context, row: EditionTrackView | undefined, fallbackTitle: string): TagSet {
  const { release, edition } = ctx;
  const credits = parseCredits(row?.credits);
  const artist = albumArtist(release, ctx.eraName);
  const discs = new Set(ctx.rows.map((r) => r.disc));
  const ids = parseIds(edition.external_ids);
  const rowIds = parseIds(row?.external_ids);
  const entryIds = parseIds(row?.entry_ids);
  return {
    title: row ? trackTitle(row) : fallbackTitle,
    artist: credits.artist || artist,
    album: edition.album_title || release.title,
    albumArtist: artist,
    track: row?.position ?? null,
    trackTotal: row ? ctx.rows.filter((r) => r.disc === row.disc).length : null,
    disc: row && discs.size > 1 ? row.disc : null,
    discTotal: discs.size > 1 ? Math.max(...discs) : null,
    date: edition.release_date || release.release_date,
    catalog: edition.catalog_no || release.catalog_no,
    label: artist,
    composer: credits.composer ?? null,
    lyricist: credits.lyricist ?? null,
    arranger: credits.arranger ?? null,
    mbAlbum: ids.musicbrainz_release ?? null,
    mbReleaseGroup: ids.musicbrainz_release_group ?? null,
    mbRecording: rowIds.musicbrainz_recording ?? entryIds.musicbrainz_recording ?? null,
    mbTrack: rowIds.musicbrainz_track ?? null,
    cover: ctx.cover,
  };
}

/** The name a tagged track downloads as: «03 Title.flac», «2-03 Title.flac» on multi-disc editions. */
export function trackFileName(tags: TagSet, ext: string, fallback: string): string {
  if (!tags.track) return fallback;
  const n = String(tags.track).padStart(2, '0');
  return `${tags.disc ? `${tags.disc}-` : ''}${n} ${safe(tags.title)}.${ext}`;
}

type FileForTags = Pick<FileRow, 'id' | 'name' | 'ext' | 'size' | 'mtime' | 'sha256' | 'kind' | 'blob_key' | 'edition_id' | 'track_id' | 'format'>;

/** Where a file's tagged version comes from, or null when it has none (not audio in an edition, other formats). */
export async function taggedSource(file: FileForTags, ctx?: Context | null): Promise<TaggedSource | null> {
  if (file.kind !== 'audio' || !file.edition_id || !file.blob_key) return null;
  ctx ??= await context(file.edition_id);
  if (!ctx) return null;
  const ext = file.ext.toLowerCase();
  let key = file.blob_key;
  let size = file.size;
  let format: 'flac' | 'mp3';
  if (ext === 'flac') format = 'flac';
  else if (ext === 'mp3') format = 'mp3';
  else if ((ext === 'wav' || ext === 'aif' || ext === 'aiff') && file.sha256) {
    const stream = await db().prepare("SELECT key, size FROM derived WHERE sha256 = ? AND kind = 'stream'").bind(file.sha256).first<{ key: string; size: number }>();
    if (!stream) return null;
    key = stream.key;
    size = stream.size;
    format = 'flac';
  } else return null;
  const row = file.track_id ? ctx.rows.find((r) => r.track_id === file.track_id) : undefined;
  const stem = file.name.replace(/\.[^.]+$/, '');
  const tags = tagSet(ctx, row, parseFormat(file.format).tags?.title ?? stem);
  return { file, tags, format, key, size, name: trackFileName(tags, format, `${stem}.${format}`) };
}

function vorbisFields(t: TagSet): [string, string][] {
  const f: [string, string | number | null][] = [
    ['TITLE', t.title], ['ARTIST', t.artist], ['ALBUM', t.album], ['ALBUMARTIST', t.albumArtist],
    ['TRACKNUMBER', t.track], ['TRACKTOTAL', t.trackTotal], ['DISCNUMBER', t.disc], ['DISCTOTAL', t.discTotal],
    ['DATE', t.date], ['CATALOGNUMBER', t.catalog], ['LABEL', t.label], ['COMPOSER', t.composer], ['LYRICIST', t.lyricist],
    ['ARRANGER', t.arranger], ['MUSICBRAINZ_ALBUMID', t.mbAlbum], ['MUSICBRAINZ_RELEASEGROUPID', t.mbReleaseGroup],
    ['MUSICBRAINZ_TRACKID', t.mbRecording], ['MUSICBRAINZ_RELEASETRACKID', t.mbTrack],
  ];
  return f.filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, String(v)]);
}

async function readRange(media: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  const object = await media.get(key, { range: { offset, length } });
  if (!object) throw new Error(`missing ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

async function coverBytes(media: R2Bucket, cover: TagSet['cover']): Promise<{ image: Uint8Array; mime: string } | null> {
  if (!cover) return null;
  const object = await media.get(cover.key);
  if (!object) return null;
  return { image: new Uint8Array(await object.arrayBuffer()), mime: cover.ext.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg' };
}

/** The new header and the part of the stored object that follows it. */
export async function taggedParts(media: R2Bucket, src: TaggedSource): Promise<{ header: Uint8Array; offset: number; length: number }> {
  const read = (offset: number, length: number) => readRange(media, src.key, offset, Math.max(0, Math.min(length, src.size - offset)));
  const cover = await coverBytes(media, src.tags.cover);
  if (src.format === 'flac') {
    const layout = await readFlacLayout(read);
    const header = flacHeader(layout, vorbisComment(vorbisFields(src.tags)), cover ? pictureBlock(cover.image, cover.mime) : null);
    return { header, offset: layout.audioOffset, length: src.size - layout.audioOffset };
  }
  const range = await mp3AudioRange(src.size, read);
  const t = src.tags;
  const header = id3v24({
    title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
    track: t.track ? `${t.track}${t.trackTotal ? `/${t.trackTotal}` : ''}` : undefined,
    disc: t.disc ? `${t.disc}${t.discTotal ? `/${t.discTotal}` : ''}` : undefined,
    date: t.date ?? undefined, composer: t.composer ?? undefined, lyricist: t.lyricist ?? undefined, publisher: t.label ?? undefined,
    custom: [
      ['CATALOGNUMBER', t.catalog ?? ''], ['ARRANGER', t.arranger ?? ''], ['MusicBrainz Album Id', t.mbAlbum ?? ''],
      ['MusicBrainz Release Group Id', t.mbReleaseGroup ?? ''], ['MusicBrainz Release Track Id', t.mbTrack ?? ''],
    ],
    ufid: t.mbRecording ? { owner: 'http://musicbrainz.org', id: t.mbRecording } : undefined,
    cover,
  });
  return { header, offset: range.start, length: range.end - range.start };
}

function bodyStream(media: R2Bucket, key: string, header: Uint8Array, offset: number, length: number): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  (async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(header);
      const object = await media.get(key, { range: { offset, length } });
      if (!object) throw new Error(`missing ${key}`);
      const reader = object.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();
  return readable;
}

export async function taggedResponse(media: R2Bucket, src: TaggedSource): Promise<Response> {
  const { header, offset, length } = await taggedParts(media, src);
  const total = header.length + length;
  const { readable, writable } = new FixedLengthStream(total);
  bodyStream(media, src.key, header, offset, length).pipeTo(writable).catch(() => undefined);
  return new Response(readable, {
    headers: {
      'content-type': src.format === 'flac' ? 'audio/flac' : 'audio/mpeg',
      'content-length': String(total),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(src.name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function taggedEntry(media: R2Bucket, src: TaggedSource, folder: string): Promise<ZipEntry> {
  const { header, offset, length } = await taggedParts(media, src);
  return {
    name: `${folder}${src.name}`,
    size: header.length + length,
    mtime: src.file.mtime ? new Date(src.file.mtime) : new Date(),
    body: async () => bodyStream(media, src.key, header, offset, length),
  };
}

export async function editionContext(editionId: string): Promise<Context | null> {
  return context(editionId);
}

export { concat };
