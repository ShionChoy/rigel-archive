// What the 整理台's inspector (the right-hand pane) shows: the open or selected folder, one file, several
// files; and the 回收站 (files deleted recently, restored by undoing their deletion).

import { editionCovers } from './covers';
import { db, parseFormat, parseSuggestion, type FileRow, type Suggestion } from './db';
import { formName } from './forms';
import type { T } from './i18n';
import { folderKey, type FolderInfo, type Places } from './locations';

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
  release?: { id: string; catalog_no: string | null; title: string; form: string; release_date: string | null; state: string; tracks: number }; // form: its name
  edition?: {
    id: string; slot: string; type: string; name: string; status: string; catalog_no: string | null; release_date: string | null; tracks: number;
    covers: { src: string; name: string; chosen: boolean; tracks: number | null }[]; // chosen by hand, or what its tracks carry
  };
  texts: { id: string; name: string }[]; // text files directly in it (for 说明文件)
  readme: { id: string; name: string; blob_key: string | null } | null;
  pinned: boolean;
}

function releaseView(
  r: (Omit<NonNullable<FolderView['release']>, 'form'> & { form: string | null; name_zh: string | null; name_ja: string | null }) | undefined, t: T,
): FolderView['release'] {
  if (!r) return undefined;
  const { name_zh, name_ja, ...rest } = r;
  return { ...rest, form: name_zh ? formName({ name_zh, name_ja: name_ja ?? '' }, t) : r.form || t('未设置') };
}

export async function folderView(places: Places, id: string, t: T, pinned: boolean): Promise<FolderView | null> {
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
      .prepare(
        `SELECT r.id, r.catalog_no, r.title, r.form, f.name_zh, f.name_ja, r.release_date, r.state, (SELECT count(*) FROM tracks WHERE release_id = r.id) AS tracks
         FROM releases r LEFT JOIN release_forms f ON f.id = r.form WHERE r.id = ?`,
      )
      .bind(folder.release_id ?? ''),
    database
      .prepare(
        `SELECT e.id, e.slot, e.name, e.status, e.catalog_no, e.release_date, (SELECT count(*) FROM edition_tracks WHERE edition_id = e.id) AS tracks
         FROM editions e WHERE e.id = ?`,
      )
      .bind(folder.edition_id ?? ''),
    database.prepare('SELECT id, name, blob_key FROM files WHERE id = ?').bind(folder.readme_file_id ?? ''),
  ]);
  const s = stats.results[0] as { own: number | null; total: number; bytes: number };
  const e = edition.results[0] as Omit<NonNullable<FolderView['edition']>, 'covers' | 'type'> | undefined;
  let editionView: FolderView['edition'];
  if (e) {
    const covers = (await editionCovers([e.id], { size: 240 })).get(e.id) ?? [];
    editionView = {
      ...e, type: places.types.label(e.slot, t),
      covers: covers.map((c) => ({ src: c.src, name: c.file?.name ?? '', chosen: c.source === 'chosen', tracks: c.tracks ?? null })),
    };
  }
  return {
    folder,
    key: folderKey(id),
    name: places.folderName(folder, t),
    stats: { own: s.own ?? 0, total: s.total, bytes: s.bytes, folders: sub.length - 1 },
    release: releaseView(release.results[0] as (Omit<NonNullable<FolderView['release']>, 'form'> & { form: string | null; name_zh: string | null; name_ja: string | null }) | undefined, t),
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
  cover_of: 'edition' | null; // a picture chosen as its edition's cover (of its tracks, or of an edition without tracks)
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
                   WHEN EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = f.edition_id AND json_extract(et.cover, '$.file') = f.id) THEN 'edition' END AS cover_of
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
