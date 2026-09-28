// Downloads with tags: every audio file of an edition is written with its track row's tags (lib/tagging,
// Picard's names) over what the file carries, the track numbers from the list's order and, when one was
// chosen, the row's cover. FLAC, MP3, WAV (it stays WAV; its stream FLAC is offered too), M4A and Ogg keep
// their audio byte for byte. The original is never changed and stays downloadable as it was collected.

import { db, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { trackTitle, type EditionTrackView } from './editions';
import { concat } from './tagging/bytes';
import { albumArtist, catalogTags, commonAlbumTags } from './rowtags';
import { numberTags, parseTags, type Tags } from './tagging/model';
import { renumberOgg } from './tagging/ogg';
import { WRITABLE, layoutLength, taggedLayout, type Layout, type Part } from './tagging/write';
import type { ZipEntry } from './tagging/zip';

/** Pictures a download can embed as they are; larger ones use their 1600 px copy (derived «embed»). */
export const COVER_MAX = 12_000_000;

export interface RowCover {
  file?: string; // a picture file's id
  picture?: string; // an embedded picture's sha256
  mode: 'replace' | 'add';
}

export function parseCover(raw: string | null | undefined): RowCover | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return null;
    const mode = v.mode === 'add' ? 'add' : 'replace';
    if (typeof v.file === 'string' && v.file) return { file: v.file, mode };
    if (typeof v.picture === 'string' && /^[0-9a-f]{64}$/.test(v.picture)) return { picture: v.picture, mode };
    return null;
  } catch {
    return null;
  }
}

export interface TagRow extends EditionTrackView {
  tags: string;
  cover: string | null;
}

export interface Context {
  release: ReleaseRow & { era_name: string };
  edition: EditionRow;
  rows: TagRow[];
}

export async function editionContext(editionId: string): Promise<Context | null> {
  const database = db();
  const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(editionId).first<EditionRow>();
  if (!edition) return null;
  const [release, rows] = await Promise.all([
    database.prepare('SELECT r.*, e.name AS era_name FROM releases r JOIN eras e ON e.id = r.era_id WHERE r.id = ?').bind(edition.release_id).first<ReleaseRow & { era_name: string }>(),
    database
      .prepare(
        `SELECT et.*, t.title AS entry_title, t.version_label, t.song_id, t.credits, t.duration_ms AS entry_duration, t.external_ids AS entry_ids
         FROM edition_tracks et JOIN tracks t ON t.id = et.track_id WHERE et.edition_id = ? ORDER BY et.disc, et.position, et.id`,
      )
      .bind(editionId)
      .all<TagRow>(),
  ]);
  if (!release) return null;
  return { release, edition, rows: rows.results };
}

/**
 * The album-level tags a file without a row gets: the values every row of the edition agrees on, else what
 * the catalog says.
 */
export function albumTags(ctx: Context): Tags {
  return ctx.rows.length ? commonAlbumTags(ctx.rows.map((r) => r.tags)) : catalogTags(ctx.release, ctx.edition);
}

/** A row's tags for writing: its own, plus its number on its disc. */
export function rowTags(ctx: Context, row: TagRow): Tags {
  const discs = new Set(ctx.rows.map((r) => r.disc));
  const onDisc = ctx.rows.filter((r) => r.disc === row.disc).length;
  return { ...parseTags(row.tags), ...numberTags(row.position, row.disc, discs.size, onDisc) };
}

/** The title a row shows and downloads as: its title tag, else the edition's or the track's title. */
export function rowTitle(row: TagRow | EditionTrackView & { tags?: string }): string {
  return parseTags(row.tags).title?.[0] ?? trackTitle(row);
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

/** «03 Title.flac», «2-03 Title.flac» on multi-disc editions. */
export function trackFileName(title: string, position: number | null, disc: number | null, ext: string, fallback: string): string {
  if (!position) return fallback;
  return `${disc ? `${disc}-` : ''}${String(position).padStart(2, '0')} ${safe(title)}.${ext}`;
}

type FileForTags = Pick<FileRow, 'id' | 'name' | 'ext' | 'size' | 'mtime' | 'sha256' | 'kind' | 'blob_key' | 'edition_id' | 'track_id' | 'format'> & {
  download_name?: string | null;
};

export interface TaggedSource {
  file: FileForTags;
  ext: string; // the format written (a WAV asked for as FLAC is its stream FLAC)
  key: string; // the stored object the audio comes from
  size: number;
  name: string; // download name
  tags: Tags;
  cover: RowCover | null;
}

/**
 * Where a file's tagged download comes from, or null when it has none (not audio in an edition, a
 * format that cannot be tagged). `as: 'flac'` gives a WAV / AIFF as its stream FLAC (identical samples).
 */
export async function taggedSource(file: FileForTags, ctx?: Context | null, as?: 'flac'): Promise<TaggedSource | null> {
  if (file.kind !== 'audio' || !file.edition_id || !file.blob_key) return null;
  ctx ??= await editionContext(file.edition_id);
  if (!ctx) return null;
  let ext = file.ext.toLowerCase();
  let key = file.blob_key;
  let size = file.size;
  if ((as === 'flac' && (ext === 'wav' || ext === 'aif' || ext === 'aiff')) || ext === 'aif' || ext === 'aiff') {
    if (!file.sha256) return null;
    const stream = await db().prepare("SELECT key, size FROM derived WHERE sha256 = ? AND kind = 'stream'").bind(file.sha256).first<{ key: string; size: number }>();
    if (!stream) return null;
    key = stream.key;
    size = stream.size;
    ext = 'flac';
  }
  if (!WRITABLE.has(ext)) return null;
  const row = file.track_id ? ctx.rows.find((r) => r.track_id === file.track_id) : undefined;
  const stem = (file.download_name || file.name).replace(/\.[^.]+$/, '');
  const tags = row ? rowTags(ctx, row) : albumTags(ctx);
  const discs = new Set(ctx.rows.map((r) => r.disc));
  const name = row ? trackFileName(rowTitle(row), row.position, discs.size > 1 ? row.disc : null, ext, `${stem}.${ext}`) : `${stem}.${ext}`;
  return { file, ext, key, size, name, tags, cover: row ? parseCover(row.cover) : null };
}

async function readRange(media: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  const object = await media.get(key, { range: { offset, length } });
  if (!object) throw new Error(`missing ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

/** The bytes of a row's chosen cover (a picture file, or a picture embedded in some track). */
export async function coverBytes(media: R2Bucket, cover: RowCover | null): Promise<{ image: Uint8Array; mime: string } | null> {
  if (!cover) return null;
  const database = db();
  let key: string | null = null;
  let mime = 'image/jpeg';
  if (cover.picture) {
    const p = await database.prepare('SELECT key, mime, size FROM pictures WHERE sha256 = ?').bind(cover.picture).first<{ key: string; mime: string; size: number }>();
    if (p && p.size < COVER_MAX) {
      key = p.key;
      mime = p.mime;
    }
  } else if (cover.file) {
    const f = await database
      .prepare("SELECT blob_key, ext, size, sha256 FROM files WHERE id = ? AND kind = 'image' AND blob_key IS NOT NULL")
      .bind(cover.file)
      .first<{ blob_key: string; ext: string; size: number; sha256: string | null }>();
    if (f && f.size < COVER_MAX && /^(jpe?g|png)$/i.test(f.ext)) {
      key = f.blob_key;
      mime = f.ext.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
    } else if (f?.sha256) {
      // A large scan: its 1600 px JPEG copy made by the processing program.
      const d = await database.prepare("SELECT key FROM derived WHERE sha256 = ? AND kind = 'embed'").bind(f.sha256).first<{ key: string }>();
      if (d) key = d.key;
    }
  }
  if (!key) return null;
  const object = await media.get(key);
  if (!object) return null;
  return { image: new Uint8Array(await object.arrayBuffer()), mime };
}

export async function taggedParts(media: R2Bucket, src: TaggedSource): Promise<Layout> {
  const read = (offset: number, length: number) => readRange(media, src.key, offset, Math.max(0, Math.min(length, src.size - offset)));
  const cover = await coverBytes(media, src.cover);
  return taggedLayout(src.ext, read, src.size, { tags: src.tags, cover, coverMode: src.cover?.mode ?? 'replace' });
}

/** The parts one after the other: bytes as they are, ranges from storage (Ogg ranges renumbered). */
function bodyStream(media: R2Bucket, key: string, parts: Part[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  (async () => {
    const writer = writable.getWriter();
    try {
      // Small parts next to each other go out as one write.
      let pending: Uint8Array[] = [];
      const flush = async () => {
        if (pending.length) await writer.write(concat(pending));
        pending = [];
      };
      for (const p of parts) {
        if (p instanceof Uint8Array) {
          pending.push(p);
          continue;
        }
        await flush();
        if (p.length === 0) continue;
        const object = await media.get(key, { range: { offset: p.offset, length: p.length } });
        if (!object) throw new Error(`missing ${key}`);
        const source = p.ogg ? object.body.pipeThrough(renumberOgg(p.ogg.serial, p.ogg.delta)) : object.body;
        const reader = source.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      await flush();
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();
  return readable;
}

export async function taggedResponse(media: R2Bucket, src: TaggedSource): Promise<Response> {
  const layout = await taggedParts(media, src);
  const total = layoutLength(layout);
  const { readable, writable } = new FixedLengthStream(total);
  bodyStream(media, src.key, layout.parts).pipeTo(writable).catch(() => undefined);
  return new Response(readable, {
    headers: {
      'content-type': layout.mime,
      'content-length': String(total),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(src.name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function taggedEntry(media: R2Bucket, src: TaggedSource, folder: string): Promise<ZipEntry> {
  const layout = await taggedParts(media, src);
  return {
    name: `${folder}${src.name}`,
    size: layoutLength(layout),
    mtime: src.file.mtime ? new Date(src.file.mtime) : new Date(),
    body: async () => bodyStream(media, src.key, layout.parts),
  };
}

export { albumArtist, concat };
