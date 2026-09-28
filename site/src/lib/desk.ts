// What the 整理台's inspector (the right-hand pane) shows: the open or selected folder, one file, several
// files; and the 回收站 (files deleted recently, restored by undoing their deletion).

import { db, parseFormat, parseSuggestion, type FileRow, type Suggestion } from './db';
import { folderKey, type FolderInfo, type Places } from './locations';
import { imageSrc } from './media';
import { derivedFor } from './processing';

export interface FolderStats {
  own: number; // files directly in it
  total: number; // with the folders below
  bytes: number;
  folders: number; // folders below
}

export interface FolderView {
  folder: FolderInfo;
  key: string;
  name: string;
  stats: FolderStats;
  release?: { id: string; catalog_no: string | null; title: string; kind: string; release_date: string | null; state: string; tracks: number };
  edition?: {
    id: string; slot: string; name: string; status: string; catalog_no: string | null; release_date: string | null; tracks: number;
    cover: { src: string | null; name: string; own: boolean } | null; // the cover its 整理版 embeds (own = the edition's, else the release's)
  };
  texts: { id: string; name: string }[]; // text files directly in it (for 说明文件)
  readme: { id: string; name: string; blob_key: string | null } | null;
  pinned: boolean;
}

export async function folderView(places: Places, id: string, t: (s: string) => string, pinned: boolean): Promise<FolderView | null> {
  const folder = places.folders.get(id);
  if (!folder) return null;
  const database = db();
  const sub = places.subtree(id);
  const [stats, texts, release, edition, readme] = await database.batch([
    database
      .prepare(
        `SELECT sum(folder_id = ?1) AS own, count(*) AS total, coalesce(sum(size), 0) AS bytes FROM files
         WHERE folder_id IN (SELECT value FROM json_each(?2)) AND sealed_in IS NULL`,
      )
      .bind(id, JSON.stringify(sub)),
    database.prepare("SELECT id, name FROM files WHERE folder_id = ? AND kind = 'text' AND sealed_in IS NULL ORDER BY name LIMIT 200").bind(id),
    database
      .prepare('SELECT id, catalog_no, title, kind, release_date, state, (SELECT count(*) FROM tracks WHERE release_id = r.id) AS tracks FROM releases r WHERE id = ?')
      .bind(folder.release_id ?? ''),
    database
      .prepare(
        `SELECT e.id, e.slot, e.name, e.status, e.catalog_no, e.release_date, (SELECT count(*) FROM edition_tracks WHERE edition_id = e.id) AS tracks,
                e.cover_file_id IS NOT NULL AS own_cover, c.name AS cover_name, c.sha256 AS cover_sha, c.blob_key AS cover_key
         FROM editions e JOIN releases r ON r.id = e.release_id LEFT JOIN files c ON c.id = coalesce(e.cover_file_id, r.cover_file_id)
         WHERE e.id = ?`,
      )
      .bind(folder.edition_id ?? ''),
    database.prepare('SELECT id, name, blob_key FROM files WHERE id = ?').bind(folder.readme_file_id ?? ''),
  ]);
  const s = stats.results[0] as { own: number | null; total: number; bytes: number };
  type E = NonNullable<FolderView['edition']> & { own_cover: number; cover_name: string | null; cover_sha: string | null; cover_key: string | null };
  const e = edition.results[0] as E | undefined;
  let editionView: FolderView['edition'];
  if (e) {
    const { own_cover, cover_name, cover_sha, cover_key, ...rest } = e;
    const derived = cover_sha ? (await derivedFor(database, [cover_sha])).get(cover_sha) : undefined;
    editionView = { ...rest, cover: cover_name ? { name: cover_name, own: !!own_cover, src: imageSrc(cover_key ? `/admin/media/${cover_key}` : null, derived, 240) } : null };
  }
  return {
    folder,
    key: folderKey(id),
    name: places.folderName(folder, t),
    stats: { own: s.own ?? 0, total: s.total, bytes: s.bytes, folders: sub.length - 1 },
    release: release.results[0] as FolderView['release'],
    edition: editionView,
    texts: texts.results as { id: string; name: string }[],
    readme: (readme.results[0] as FolderView['readme']) ?? null,
    pinned,
  };
}

export type FileView = FileRow & {
  suggestion: Suggestion | null;
  track_title: string | null;
  edition_has_tracks: number;
  copies: number;
  members: number;
  cover_of: 'edition' | 'release' | null; // a picture that is its edition's or release's cover
};

export async function fileView(id: string): Promise<FileView | null> {
  const row = await db()
    .prepare(
      `SELECT f.*,
              (SELECT coalesce(et.title, t.title) FROM tracks t LEFT JOIN edition_tracks et ON et.track_id = t.id AND et.edition_id = f.edition_id WHERE t.id = f.track_id) AS track_title,
              EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = f.edition_id) AS edition_has_tracks,
              CASE WHEN f.sha256 IS NULL THEN 1 ELSE (SELECT count(*) FROM files c WHERE c.sha256 = f.sha256) END AS copies,
              (SELECT count(*) FROM files m WHERE m.sealed_in = f.id) AS members,
              CASE WHEN f.kind != 'image' THEN NULL
                   WHEN EXISTS (SELECT 1 FROM editions e WHERE e.id = f.edition_id AND e.cover_file_id = f.id) THEN 'edition'
                   WHEN EXISTS (SELECT 1 FROM releases r WHERE r.id = f.release_id AND r.cover_file_id = f.id) THEN 'release' END AS cover_of
       FROM files f WHERE f.id = ?`,
    )
    .bind(id)
    .first<FileView & { suggest: string | null }>();
  if (!row) return null;
  return { ...row, suggestion: parseSuggestion(row.suggest) };
}

export interface FilesSummary {
  count: number;
  bytes: number;
  kinds: { kind: string; n: number }[];
  placed: number;
  suggested: number;
  archives: number;
  sealed: number;
  uploads: number;
  ignored: number;
  rights: { rights: string; n: number }[];
}

export async function filesSummary(ids: string[]): Promise<FilesSummary> {
  const database = db();
  const list = JSON.stringify(ids.slice(0, 20000));
  const [totals, kinds, rights] = await database.batch([
    database
      .prepare(
        `SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes, sum(folder_id IS NOT NULL) AS placed,
                sum(suggest IS NOT NULL AND folder_id IS NULL) AS suggested,
                sum(kind IN ('archive', 'disc_image') OR json_extract(format, '$.archive') IS NOT NULL) AS archives,
                sum(sealed = 1) AS sealed, sum(origin = 'upload') AS uploads, sum(state = 'ignored') AS ignored
         FROM files WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .bind(list),
    database.prepare('SELECT kind, count(*) AS n FROM files WHERE id IN (SELECT value FROM json_each(?)) GROUP BY kind ORDER BY n DESC').bind(list),
    database.prepare('SELECT rights, count(*) AS n FROM files WHERE id IN (SELECT value FROM json_each(?)) GROUP BY rights ORDER BY n DESC').bind(list),
  ]);
  const t = totals.results[0] as Record<string, number | null>;
  const n = (k: string) => Number(t[k] ?? 0);
  return {
    count: n('count'), bytes: n('bytes'), placed: n('placed'), suggested: n('suggested'), archives: n('archives'),
    sealed: n('sealed'), uploads: n('uploads'), ignored: n('ignored'),
    kinds: kinds.results as { kind: string; n: number }[],
    rights: rights.results as { rights: string; n: number }[],
  };
}

export interface TrashBatch {
  batch_id: string;
  at: string;
  actor: string;
  summary: string;
  n: number;
  names: string;
  bytes: number;
}

/** File deletions not undone yet whose content is still kept (STORAGE_GRACE_DAYS), newest first. */
export async function trashBatches(graceDays: number): Promise<TrashBatch[]> {
  const { results } = await db()
    .prepare(
      `SELECT batch_id, max(at) AS at, max(actor) AS actor, max(summary) AS summary, count(*) AS n,
              group_concat(json_extract(before, '$.name'), ' · ') AS names, coalesce(sum(json_extract(before, '$.size')), 0) AS bytes
       FROM revisions WHERE entity = 'file' AND action = 'delete' AND reverted_by_batch IS NULL
         AND at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
       GROUP BY batch_id ORDER BY max(at) DESC LIMIT 100`,
    )
    .bind(`-${graceDays} days`)
    .all<TrashBatch>();
  return results.map((r) => ({ ...r, names: (r.names ?? '').slice(0, 300) }));
}

/** A short description of a file's format for a row (kept here so the page and the inspector agree). */
export function fileFormat(row: Pick<FileRow, 'format'>) {
  return parseFormat(row.format);
}
