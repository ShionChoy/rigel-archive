// 文件原值: the tags and pictures every stored audio content carries, read once by the site itself (range
// reads of the head and tail of the file in R2, lib/tagging/read.ts) and kept in the table `embedded`.
// Pictures are stored once each under pictures/<sha256 of the image>: an album whose 15 tracks carry the
// same cover has one picture. The reading runs in the background (the 10-minute cron, and the 「立即读取」
// button on the storage page) and, for the few files a page is about to show, right away.

import { db } from './db';
import { imageSize } from './tagging/bytes';
import { frontCover, readEmbedded, type Embedded } from './tagging/read';
import type { Tags } from './tagging/names';

/** The reader's version: contents read by an older one are read again. */
export const READER_VERSION = 1;
/** Formats the reader understands (others get an empty row, so they are not tried again). */
const READABLE = new Set(['flac', 'mp3', 'aac', 'wav', 'aif', 'aiff', 'm4a', 'mp4', 'm4b', 'ogg', 'opus', 'oga']);

export interface PictureRef {
  sha256: string;
  type: number;
  description: string;
  mime: string;
  width: number | null;
  height: number | null;
  size: number;
}

export interface EmbeddedRow {
  sha256: string;
  version: number;
  format: string | null;
  tags: Tags;
  native: [string, string][];
  pictures: PictureRef[];
  cover: string | null;
  error: string | null;
}

interface Content {
  sha256: string;
  key: string;
  ext: string;
  size: number;
}

/** SQL (on `files` f): a stored audio content the reader has not read (at its current version). */
export const UNREAD = `f.kind = 'audio' AND f.blob_key IS NOT NULL AND f.sha256 IS NOT NULL AND f.sealed_in IS NULL
  AND NOT EXISTS (SELECT 1 FROM embedded m WHERE m.sha256 = f.sha256 AND m.version >= ${READER_VERSION})`;

export const pictureUrl = (sha256: string) => `/admin/media/pictures/${sha256}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store the pictures (those not stored yet) and return their references. */
async function storePictures(database: D1Database, media: R2Bucket, e: Embedded): Promise<PictureRef[]> {
  const refs: PictureRef[] = [];
  for (const p of e.pictures) {
    const sha = await sha256Hex(p.image);
    const size = imageSize(p.image);
    const ref: PictureRef = {
      sha256: sha, type: p.type, description: clip(p.description, 200), mime: size?.mime ?? p.mime,
      width: size?.width || null, height: size?.height || null, size: p.image.length,
    };
    refs.push(ref);
    const known = await database.prepare('SELECT 1 FROM pictures WHERE sha256 = ?').bind(sha).first();
    if (known) continue;
    const key = `pictures/${sha}`;
    if (!(await media.head(key))) await media.put(key, p.image, { httpMetadata: { contentType: ref.mime } });
    await database
      .prepare('INSERT OR IGNORE INTO pictures (sha256, key, mime, width, height, size) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(sha, key, ref.mime, ref.width, ref.height, ref.size)
      .run();
  }
  return refs;
}

/** Read one content and keep what it carries (errors are kept too, so a broken file is not retried). */
export async function readContent(database: D1Database, media: R2Bucket, c: Content): Promise<void> {
  let row: { format: string | null; tags: string; native: string; pictures: string; cover: string | null; error: string | null };
  try {
    const read = async (offset: number, length: number): Promise<Uint8Array> => {
      const len = Math.max(0, Math.min(length, c.size - offset));
      if (len === 0 || offset < 0) return new Uint8Array(0);
      const object = await media.get(c.key, { range: { offset, length: len } });
      if (!object) throw new Error('存储里没有这个文件');
      return new Uint8Array(await object.arrayBuffer());
    };
    const e = READABLE.has(c.ext.toLowerCase()) ? await readEmbedded(read, c.size, c.ext) : { format: 'none', native: [], tags: {}, pictures: [] };
    const pictures = await storePictures(database, media, e);
    const native = e.native.slice(0, 400).map(([k, v]) => [clip(k, 200), clip(v, 20000)]);
    const tags = Object.fromEntries(Object.entries(e.tags).slice(0, 300).map(([k, v]) => [clip(k, 60), v.slice(0, 50).map((x) => clip(x, 20000))]));
    row = {
      format: e.format, tags: JSON.stringify(tags), native: JSON.stringify(native), pictures: JSON.stringify(pictures),
      cover: frontCover(pictures)?.sha256 ?? null, error: null,
    };
  } catch (err) {
    row = { format: null, tags: '{}', native: '[]', pictures: '[]', cover: null, error: clip(err instanceof Error ? err.message : String(err), 500) };
  }
  await database
    .prepare(
      `INSERT INTO embedded (sha256, version, format, tags, native, pictures, cover, error, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT (sha256) DO UPDATE SET version = excluded.version, format = excluded.format, tags = excluded.tags,
         native = excluded.native, pictures = excluded.pictures, cover = excluded.cover, error = excluded.error, read_at = excluded.read_at`,
    )
    .bind(c.sha256, READER_VERSION, row.format, row.tags, row.native, row.pictures, row.cover, row.error)
    .run();
}

async function contents(database: D1Database, where: string, binds: unknown[], limit: number): Promise<Content[]> {
  const { results } = await database
    .prepare(
      `SELECT f.sha256, min(f.blob_key) AS key, min(f.ext) AS ext, max(f.size) AS size FROM files f
       WHERE ${UNREAD} AND ${where} GROUP BY f.sha256
       ORDER BY max(f.edition_id IS NOT NULL) DESC, max(f.release_id IS NOT NULL) DESC, max(f.created_at) DESC LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<Content>();
  return results;
}

/** Reading is waiting on storage and the database: several contents at a time. */
const PARALLEL = 8;

/** Read these contents, several at a time, starting no new one after `until`. Returns how many were read. */
async function readAll(database: D1Database, media: R2Bucket, list: Content[], until: number): Promise<number> {
  let next = 0;
  let read = 0;
  const worker = async () => {
    while (next < list.length && Date.now() < until) {
      const c = list[next++];
      await readContent(database, media, c);
      read += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
  return read;
}

/**
 * Read contents not read yet, those filed in an edition first, until `budgetMs` has passed. Returns how
 * many were read and how many are still waiting.
 */
export async function readPending(database: D1Database, media: R2Bucket, budgetMs: number, limit = 2000): Promise<{ read: number; left: number }> {
  const until = Date.now() + budgetMs;
  let read = 0;
  while (Date.now() < until && read < limit) {
    const batch = await contents(database, '1', [], Math.min(100, limit - read));
    if (batch.length === 0) break;
    read += await readAll(database, media, batch, until);
  }
  return { read, left: await unreadCount(database) };
}

export async function unreadCount(database: D1Database = db()): Promise<number> {
  const row = await database.prepare(`SELECT count(DISTINCT f.sha256) AS n FROM files f WHERE ${UNREAD}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read the unread contents among these (a page about to show them), within `budgetMs`. */
export async function readNow(database: D1Database, media: R2Bucket, shas: (string | null)[], budgetMs = 8000): Promise<number> {
  const list = [...new Set(shas.filter((s): s is string => !!s))];
  if (list.length === 0) return 0;
  const until = Date.now() + budgetMs;
  let n = 0;
  for (let i = 0; i < list.length && Date.now() < until; i += 500) {
    const todo = await contents(database, 'f.sha256 IN (SELECT value FROM json_each(?))', [JSON.stringify(list.slice(i, i + 500))], 500);
    n += await readAll(database, media, todo, until);
  }
  return n;
}

/** Forget what was read (the reader reads them again): failed ones only, or all. */
export async function rereadEmbedded(database: D1Database, failedOnly: boolean): Promise<number> {
  const r = await database.prepare(`DELETE FROM embedded ${failedOnly ? 'WHERE error IS NOT NULL' : ''}`).run();
  return r.meta.changes;
}

function parseRow(r: Record<string, unknown>): EmbeddedRow {
  const json = <T>(v: unknown, fallback: T): T => {
    try {
      return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    sha256: String(r.sha256), version: Number(r.version), format: (r.format as string) ?? null, tags: json(r.tags, {}),
    native: json(r.native, []), pictures: json(r.pictures, []), cover: (r.cover as string) ?? null, error: (r.error as string) ?? null,
  };
}

/** What these contents carry, by content. */
export async function embeddedFor(shas: (string | null)[], database: D1Database = db()): Promise<Map<string, EmbeddedRow>> {
  const list = [...new Set(shas.filter((s): s is string => !!s))];
  const out = new Map<string, EmbeddedRow>();
  for (let i = 0; i < list.length; i += 500) {
    const { results } = await database
      .prepare('SELECT * FROM embedded WHERE sha256 IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(list.slice(i, i + 500)))
      .all<Record<string, unknown>>();
    for (const r of results) out.set(String(r.sha256), parseRow(r));
  }
  return out;
}

/** The front covers of these contents (content → picture), for thumbnails. */
export async function coversFor(shas: (string | null)[], database: D1Database = db()): Promise<Map<string, string>> {
  const list = [...new Set(shas.filter((s): s is string => !!s))];
  const out = new Map<string, string>();
  for (let i = 0; i < list.length; i += 500) {
    const { results } = await database
      .prepare('SELECT sha256, cover FROM embedded WHERE cover IS NOT NULL AND sha256 IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(list.slice(i, i + 500)))
      .all<{ sha256: string; cover: string }>();
    for (const r of results) out.set(r.sha256, r.cover);
  }
  return out;
}

export interface PictureInfo {
  sha256: string;
  mime: string;
  width: number | null;
  height: number | null;
  size: number;
}

export async function picturesFor(shas: (string | null)[], database: D1Database = db()): Promise<Map<string, PictureInfo>> {
  const list = [...new Set(shas.filter((s): s is string => !!s))];
  const out = new Map<string, PictureInfo>();
  if (list.length === 0) return out;
  const { results } = await database
    .prepare('SELECT sha256, mime, width, height, size FROM pictures WHERE sha256 IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(list))
    .all<PictureInfo>();
  for (const r of results) out.set(r.sha256, r);
  return out;
}
