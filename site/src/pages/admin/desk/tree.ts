// What the file trees show when a folder is opened (scripts/tree.ts): the 整理台's two trees and the
// 「移动到…」 dialog. GET ?folder=<id>&folder=… → the files directly in each archive folder;
// ?src=<path>&src=… → the original folders below each path that still hold files to organize (未归档),
// and the files to organize directly in it ('' is the top). Answers JSON.
import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { db, parseFormat } from '../../../lib/db';
import { UNPLACED_SQL, VISIBLE, isArchive } from '../../../lib/locations';
import { sourceChildren } from '../../../lib/inbox';

/** How many files one folder lists at most (the rest are counted). */
const LIMIT = 400;

interface Row {
  id: string;
  name: string;
  download_name: string | null;
  ext: string;
  kind: string;
  size: number;
  state: string;
  origin: string;
  edition_id: string | null;
  folder_id: string | null;
  dir: string;
  sealed: number;
  suggest: string | null;
  format: string | null;
}

const COLUMNS = 'id, name, download_name, ext, kind, size, state, origin, edition_id, folder_id, dir, sealed, suggest, format';
const collator = new Intl.Collator('ja', { numeric: true });

function file(r: Row) {
  return {
    id: r.id, name: r.download_name || r.name, orig: r.name, ext: r.ext, kind: r.kind, size: r.size, state: r.state,
    edition: r.edition_id ?? undefined, placed: !!r.folder_id || undefined, sug: (!r.folder_id && !!r.suggest) || undefined,
    upload: r.origin === 'upload' || undefined, archive: isArchive({ kind: r.kind, format: parseFormat(r.format) }) || undefined,
    sealed: !!r.sealed || undefined,
  };
}

function listed(rows: Row[]) {
  const sorted = rows.map(file).sort((a, b) => collator.compare(a.name, b.name));
  return { files: sorted.slice(0, LIMIT), more: Math.max(0, sorted.length - LIMIT) };
}

export const GET: APIRoute = async ({ url }) => {
  const database = db();
  const folderIds = url.searchParams.getAll('folder').filter((id) => /^[\w-]{1,80}$/.test(id)).slice(0, 1000);
  const paths = url.searchParams.getAll('src').map((p) => p.replace(/^\/+|\/+$/g, '')).slice(0, 200);
  const folders: Record<string, ReturnType<typeof listed>> = {};
  for (let i = 0; i < folderIds.length; i += 200) {
    const chunk = folderIds.slice(i, i + 200);
    const { results } = await database
      .prepare(`SELECT ${COLUMNS} FROM files WHERE ${VISIBLE} AND folder_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(chunk))
      .all<Row>();
    for (const id of chunk) folders[id] = listed(results.filter((r) => r.folder_id === id));
  }
  const sources: Record<string, { dirs: Awaited<ReturnType<typeof sourceChildren>>['dirs']; files: ReturnType<typeof listed>['files']; more: number }> = {};
  for (const path of [...new Set(paths)]) {
    const [children, own] = await Promise.all([
      sourceChildren(path),
      database.prepare(`SELECT ${COLUMNS} FROM files WHERE ${UNPLACED_SQL} AND files.dir = ?`).bind(path).all<Row>(),
    ]);
    sources[path] = { dirs: children.dirs, ...listed(own.results) };
  }
  return json({ folders, sources });
};
