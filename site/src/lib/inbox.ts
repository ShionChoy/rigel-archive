import { ChangeSet } from './changes';
import { RIGHTS, RIGHTS_LABELS, isOneOf } from './constants';
import type { DirNode } from '../components/DirTree.astro';
import { db, parseSuggestion, type Suggestion } from './db';
import { deleteFiles, planDelete, type DeletePlan } from './deletion';
import { newId } from './ids';
import {
  Places, TOP, UNPLACED, UNPLACED_SQL, VISIBLE, applyPatches, ensureEntityFolder, ensureFolder, folderKey, locationWhere,
  markEditionsCollected, moveFiles, placePatch, sealArchives,
} from './locations';
import { presetOf, ruleSetSql, type SmartFolder } from './smart';
import { summary, UserError, type T } from './i18n';

// ------------------------------------------------------------------------------------------ what the 整理台 shows

/** The entries at the top of the sidebar. */
export const FIXED_VIEWS = ['all', 'unplaced', 'suggested', 'ignored', 'trash'] as const;
export type FixedView = (typeof FIXED_VIEWS)[number];
export const SORTS = ['name', 'path', 'size', 'date', 'kind'] as const;
export type Sort = (typeof SORTS)[number];

export interface DeskQuery {
  view: string; // a fixed view, p:<preset> or sf:<smart folder id>; '' when a folder is open
  loc: string; // the open folder (fd:<id>), or ''
  sub: boolean; // with the files of its subfolders
  dir: string; // 按来源浏览: an original folder and everything below it
  q: string;
  sort: Sort;
  desc: boolean;
}

/** The query of a 整理台 URL. Links from before the folder tree (state=, tree=source, release=, loc=rel:…) still work. */
export function readDeskQuery(params: URLSearchParams, places: Places): DeskQuery {
  const release = params.get('release');
  let loc = params.get('loc') ?? (release ? `rel:${release}` : '');
  let view = params.get('view') ?? '';
  if (loc === UNPLACED) {
    view = 'unplaced';
    loc = '';
  }
  const canonical = loc ? places.canonical(loc) : null;
  loc = canonical && canonical !== TOP && canonical !== UNPLACED ? canonical : '';
  if (loc) view = '';
  else if (!isView(view)) {
    const state = params.get('state');
    view = state === 'ignored' ? 'ignored' : state === 'all' || state === 'classified' || state === 'published' ? 'all' : 'unplaced';
  }
  const sort = params.get('sort') ?? '';
  return {
    view,
    loc,
    sub: params.get('sub') === '1',
    dir: params.get('dir') ?? '',
    q: (params.get('q') ?? '').trim(),
    sort: isOneOf(SORTS, sort) ? sort : loc ? 'name' : 'path',
    desc: params.get('desc') === '1',
  };
}

function isView(view: string): boolean {
  if ((FIXED_VIEWS as readonly string[]).includes(view)) return true;
  if (view.startsWith('p:')) return !!presetOf(view.slice(2));
  return /^sf:[\w-]{1,40}$/.test(view);
}

const S = (field: string) => `json_extract(files.suggest, '$.${field}')`;
/** SQL (on `files`): the rules suggest a place, or keeping it whole. */
export const HAS_SUGGESTION = `(${S('release_id')} IS NOT NULL OR ${S('folder')} IS NOT NULL OR ${S('place')} IS NOT NULL OR ${S('seal')} = 1 OR ${S('state')} = 'ignored')`;

/**
 * The files a query lists. `smart` is the open smart folder, `ids` the files a preset found by code
 * (the checks that compare texts).
 */
export function deskWhere(q: DeskQuery, places: Places, smart?: SmartFolder | null, ids?: string[] | null): { sql: string; binds: unknown[] } {
  const parts: string[] = [VISIBLE];
  const binds: unknown[] = [];
  const add = (w: { sql: string; binds: unknown[] }) => {
    parts.push(w.sql);
    binds.push(...w.binds);
  };
  if (q.loc) add(locationWhere(places, q.loc, q.sub));
  else if (q.view === 'unplaced') parts.push(UNPLACED_SQL);
  else if (q.view === 'suggested') parts.push(`${UNPLACED_SQL} AND ${HAS_SUGGESTION}`);
  else if (q.view === 'ignored') parts.push("files.state = 'ignored'");
  else if (q.view.startsWith('p:')) {
    const preset = presetOf(q.view.slice(2));
    if (preset?.sql) parts.push(`(${preset.sql})`);
    else if (preset?.ids) add({ sql: 'files.id IN (SELECT value FROM json_each(?))', binds: [JSON.stringify(ids ?? [])] });
    else parts.push('0');
  } else if (q.view.startsWith('sf:')) {
    if (smart) add(ruleSetSql(smart.rules, places));
    else parts.push('0');
  } else if (q.view === 'trash') parts.push('0');
  if (q.dir) {
    // The folder and everything below it: 'a/b' plus every 'a/b/…' ('0' is the character after '/').
    // A range instead of LIKE: D1 refuses LIKE patterns longer than 50 bytes, and this uses the index.
    add({ sql: '(files.dir = ? OR (files.dir >= ? AND files.dir < ?))', binds: [q.dir, `${q.dir}/`, `${q.dir}0`] });
  }
  if (q.q) add({ sql: "instr(lower(files.dir || '/' || files.name || char(10) || coalesce(files.download_name, '')), lower(?)) > 0", binds: [q.q] });
  return { sql: `WHERE ${parts.join(' AND ')}`, binds };
}

/** ORDER BY for a query (the suggested view keeps the files of one suggested release together). */
export function deskOrder(q: DeskQuery): string {
  const dir = q.desc ? 'DESC' : 'ASC';
  const bySuggestion = q.view === 'suggested' ? `${S('release_id')} IS NULL, ${S('release_id')}, ` : '';
  switch (q.sort) {
    case 'size': return `${bySuggestion}files.size ${dir}, files.name`;
    case 'date': return `${bySuggestion}files.created_at ${dir}, files.name`;
    case 'kind': return `${bySuggestion}files.kind ${dir}, files.name`;
    case 'path': return `${bySuggestion}files.dir ${dir}, files.name ${dir}`;
    default: return `${bySuggestion}coalesce(files.download_name, files.name) ${dir}, files.dir`;
  }
}

export async function idsForQuery(q: DeskQuery, places: Places, smart?: SmartFolder | null, ids?: string[] | null): Promise<string[]> {
  const w = deskWhere(q, places, smart, ids);
  const { results } = await db().prepare(`SELECT id FROM files ${w.sql}`).bind(...w.binds).all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Counts for the sidebar's fixed entries. */
export async function viewCounts(): Promise<Record<Exclude<FixedView, 'trash'>, number>> {
  const row = await db()
    .prepare(
      `SELECT count(*) AS all_, sum(${UNPLACED_SQL}) AS unplaced, sum(${UNPLACED_SQL} AND ${HAS_SUGGESTION}) AS suggested,
              sum(files.state = 'ignored') AS ignored
       FROM files WHERE ${VISIBLE}`,
    )
    .first<{ all_: number; unplaced: number | null; suggested: number | null; ignored: number | null }>();
  return { all: row?.all_ ?? 0, unplaced: row?.unplaced ?? 0, suggested: row?.suggested ?? 0, ignored: row?.ignored ?? 0 };
}

export interface SourceNode extends DirNode {
  left: number; // still to organize
}

/** The original folders (visible files), each with how many files are still to organize. */
export async function sourceTree(onlyUnplaced = false): Promise<{ nodes: SourceNode[]; total: number; left: number }> {
  const { results } = await db()
    .prepare(
      `SELECT dir, count(*) AS n, sum(state = 'inbox' AND release_id IS NULL AND folder_id IS NULL) AS left FROM files
       WHERE ${VISIBLE} ${onlyUnplaced ? "AND release_id IS NULL AND folder_id IS NULL AND state != 'ignored'" : ''} GROUP BY dir`,
    )
    .all<{ dir: string; n: number; left: number }>();

  interface Build { name: string; path: string; n: number; left: number; children: Map<string, Build> }
  const root: Build = { name: '', path: '', n: 0, left: 0, children: new Map() };
  for (const { dir, n, left } of results) {
    root.n += n;
    root.left += left;
    if (!dir) continue;
    let node = root;
    const parts = dir.split('/');
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), n: 0, left: 0, children: new Map() };
        node.children.set(part, child);
      }
      child.n += n;
      child.left += left;
      node = child;
    });
  }
  const finish = (b: Build): SourceNode[] =>
    [...b.children.values()]
      .sort((a, c) => a.name.localeCompare(c.name, 'ja'))
      .map((c) => ({ name: c.name, path: c.path, n: c.n, left: c.left, children: finish(c) }));
  return { nodes: finish(root), total: root.n, left: root.left };
}

/** Overall progress: visible files, still to organize, and per top-level original folder. */
export async function progress(): Promise<{ total: number; left: number; ignored: number; hidden: number; tops: { name: string; n: number; left: number }[] }> {
  const [overall, tops] = await db().batch([
    db().prepare(
      `SELECT sum(sealed_in IS NULL) AS total, sum(sealed_in IS NULL AND state = 'inbox' AND release_id IS NULL AND folder_id IS NULL) AS left,
              sum(sealed_in IS NULL AND state = 'ignored') AS ignored, sum(sealed_in IS NOT NULL) AS hidden FROM files`,
    ),
    db().prepare(
      `SELECT CASE WHEN instr(dir, '/') > 0 THEN substr(dir, 1, instr(dir, '/') - 1) ELSE dir END AS name, count(*) AS n,
              sum(state = 'inbox' AND release_id IS NULL AND folder_id IS NULL) AS left
       FROM files WHERE sealed_in IS NULL GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  const o = overall.results[0] as { total: number | null; left: number | null; ignored: number | null; hidden: number | null };
  return {
    total: o.total ?? 0, left: o.left ?? 0, ignored: o.ignored ?? 0, hidden: o.hidden ?? 0,
    tops: (tops.results as { name: string; n: number; left: number }[]).filter((r) => r.name),
  };
}

/** Suggestions below this confidence are only accepted one file at a time (on the file page). */
export const MIN_BATCH_CONFIDENCE = 0.5;

export type InboxAction =
  | { action: 'accept' }
  | { action: 'move'; target: string; keep: string | null; newFolder: string | null }
  | { action: 'rights'; rights: string }
  | { action: 'ignore' }
  | { action: 'reset' }
  | { action: 'dup' }
  | { action: 'seal' }
  | { action: 'unseal' }
  | { action: 'delete' }
  | { action: 'discard' } // Delete key: delete what can be deleted (uploads, 合辑 files whose original is gone), ignore the rest
  | { action: 'note'; note: string }
  | { action: 'rename'; names: [string, string][] }; // [file id, new name]; an empty name gives the original back

export interface ActionResult {
  summary: string;
  changed: number;
  skipped: number;
  lowConfidence: number;
  batchId: string | null;
  kept?: DeletePlan; // for deletions: why some files were not deleted (keptMessage)
  refused?: string[]; // archives that could not be kept whole
  placed?: number; // accept: files put at a place (or ignored)
  sealed?: { archives: number; hidden: number }; // archives kept whole, and the files that left the 整理台
  created?: string[]; // accept: editions made because a suggestion named one that did not exist yet
  noType?: number; // accept: files skipped because their suggestion's edition type has been deleted
}

const UNPLACE = { release_id: null, edition_id: null, folder_id: null, slot: null, track_id: null };

/**
 * The edition of this type and name of a release (with its folder), made in `cs` when missing (its id is
 * added to `created`).
 */
export function ensureEdition(cs: ChangeSet, places: Places, releaseId: string, slot: string, name: string, catalog: string | null, created?: string[]): string {
  const found = [...places.editions.values()].find((e) => e.release_id === releaseId && e.slot === slot && e.name === name);
  if (found) return found.id;
  const id = newId('e');
  const row = { id, release_id: releaseId, slot, name, catalog_no: catalog, release_date: null, status: 'collected' as const, sort: 0, is_default: 0 };
  cs.queueCreate('edition', { ...row, source: null, based_on: null, track_count: null, album_title: null, cover_file_id: null, external_ids: '{}', note: null });
  places.addEdition(row);
  ensureEntityFolder(cs, places, `ed:${id}`);
  created?.push(id);
  return id;
}

/**
 * Where a suggestion puts a file (making the edition or folders it names), or null for nowhere. Only the
 * folders the rule names are made: an edition's files go into its own folder unless the rule says more.
 */
export function suggestedPlace(cs: ChangeSet, places: Places, s: Suggestion, created?: string[]): string | null {
  const folder = s.folder ? s.folder.split('/').filter(Boolean) : [];
  if (s.place && s.place !== UNPLACED && (s.place === TOP || places.exists(s.place))) {
    if (folder.length) return folderKey(ensureFolder(cs, places, s.place, folder));
    return s.place === TOP ? null : folderKey(ensureEntityFolder(cs, places, s.place));
  }
  if (s.release_id && places.releases.has(s.release_id)) {
    const entity = s.slot ? `ed:${ensureEdition(cs, places, s.release_id, s.slot, s.edition ?? '', s.edition_catalog ?? null, created)}` : `rel:${s.release_id}`;
    const key = folderKey(ensureEntityFolder(cs, places, entity));
    return folder.length ? folderKey(ensureFolder(cs, places, key, folder)) : key;
  }
  if (folder.length) {
    const under = s.era_id && places.eras.has(s.era_id) ? `era:${s.era_id}` : TOP;
    return folderKey(ensureFolder(cs, places, under, folder));
  }
  return null;
}

/** Apply an 整理台 batch action to the given files. Throws with a user-facing message on bad input. */
export async function applyInboxAction(actor: string, ids: string[], a: InboxAction, t: T): Promise<ActionResult> {
  const database = db();
  let skipped = 0;
  let lowConfidence = 0;
  let placedCount: number | undefined;
  let sealed: { archives: number; hidden: number } | undefined;
  let created: string[] | undefined;
  let noType = 0;
  let refused: string[] | undefined;
  let cs: ChangeSet;

  if (a.action === 'delete') {
    const r = await deleteFiles(database, actor, ids);
    return { summary: r.count ? r.summary : summary('没有删除文件'), changed: r.count, skipped: 0, lowConfidence: 0, kept: r, batchId: r.batchId };
  }
  if (a.action === 'discard') {
    // One batch: the files that can be deleted go to the 回收站, the 合辑 files whose original is still
    // there are ignored (deleting them would bring them back with the next import).
    const plan = await planDelete(database, ids);
    const deleted = new Set(plan.levels.flat());
    const rows = await loadRows<{ id: string; state: string; sealed_in: string | null }>('id, state, sealed_in', ids);
    const ignore = rows.filter((r) => !deleted.has(r.id) && !r.sealed_in && r.state !== 'published' && r.state !== 'ignored').map((r) => r.id);
    cs = new ChangeSet(database, actor, plan.count === 0
      ? summary('忽略 {m} 个文件（合辑里的原件还在，只能忽略）', { m: ignore.length })
      : ignore.length === 0
        ? summary('删除 {n} 个文件（30 天内可在回收站恢复）', { n: plan.count })
        : summary('删除 {n} 个文件、忽略 {m} 个（合辑里的原件还在的只能忽略）', { n: plan.count, m: ignore.length }));
    if (ignore.length) cs.updateFiles(ignore, { ...UNPLACE, state: 'ignored' });
    if (plan.count) cs.deleteFiles(plan.levels);
    const changed = await cs.commit();
    return { summary: cs.summary, changed, skipped: ids.length - ignore.length - plan.count + plan.members, lowConfidence: 0, batchId: changed ? cs.batchId : null };
  }
  if (a.action === 'note') {
    if (ids.length !== 1) throw new UserError('备注一次只能改一个文件');
    if (a.note.length > 2000) throw new UserError('内容过长');
    cs = new ChangeSet(database, actor, summary('修改文件备注'));
    await cs.update('file', { id: ids[0] }, { note: a.note.trim() || null });
    const changed = await cs.commit();
    return { summary: cs.summary, changed, skipped: 0, lowConfidence: 0, batchId: changed ? cs.batchId : null };
  }
  if (a.action === 'rename') return renameFiles(actor, a.names);
  if (a.action === 'move') {
    const r = await moveFiles(actor, ids, a.target, t, a.keep, a.newFolder);
    return { summary: r.summary, changed: r.changed, skipped: r.skipped, lowConfidence: 0, batchId: r.batchId };
  }
  if (a.action === 'seal' || a.action === 'unseal') {
    const r = await sealArchives(actor, ids, a.action === 'seal');
    return {
      summary: r.summary, changed: r.changed, skipped: r.skipped, lowConfidence: 0, batchId: r.changed ? r.batchId : null, refused: r.refused,
      sealed: { archives: r.archives, hidden: r.hidden },
    };
  }

  const visible = async (columns: string) =>
    (await loadRows<{ id: string; sealed_in: string | null } & Record<string, unknown>>(columns, ids)).filter((r) => {
      if (r.sealed_in) skipped += 1;
      return !r.sealed_in;
    });

  switch (a.action) {
    case 'accept': {
      const places = await Places.load();
      const rows = await visible('id, state, rights, release_id, track_id, sealed_in, suggest, kind, format');
      cs = new ChangeSet(database, actor, summary('整理台：按建议确认 {n} 个文件', { n: 0 }));
      const suggestions = new Map<string, Suggestion>();
      const unsure = new Set<string>();
      const none = new Set<string>();
      for (const row of rows) {
        const s = parseSuggestion(row.suggest as string | null);
        if (!s) none.add(row.id);
        else if (s.confidence < MIN_BATCH_CONFIDENCE && ids.length > 1) unsure.add(row.id);
        else suggestions.set(row.id, s);
      }
      const isArchive = (row: Record<string, unknown>) =>
        row.kind === 'archive' || row.kind === 'disc_image' || String(row.format ?? '').includes('"archive"');
      let seals = rows.filter((r) => suggestions.get(r.id)?.seal && isArchive(r)).map((r) => r.id);
      // Files inside an archive kept whole in this same step are not filed one by one.
      const inside = new Set<string>();
      if (seals.length) {
        const { results } = await database
          .prepare(
            `WITH RECURSIVE m(id) AS (
               SELECT id FROM files WHERE member_of IN (SELECT value FROM json_each(?1))
               UNION ALL SELECT f.id FROM files f JOIN m ON f.member_of = m.id)
             SELECT id FROM m`,
          )
          .bind(JSON.stringify(seals))
          .all<{ id: string }>();
        for (const { id } of results) inside.add(id);
      }
      for (const id of inside) {
        unsure.delete(id);
        none.delete(id);
      }
      seals = seals.filter((id) => !inside.has(id)); // an archive inside another one kept whole goes with it
      lowConfidence = unsure.size;
      skipped += none.size;
      // A suggestion whose edition type has been deleted since is skipped (and said so).
      for (const row of rows) {
        const s = suggestions.get(row.id);
        if (s?.slot && s.release_id && !s.place && !places.types.has(s.slot) && !inside.has(row.id)) {
          suggestions.delete(row.id);
          noType += 1;
        }
      }
      seals = seals.filter((id) => suggestions.has(id));
      const patches = new Map<string, Record<string, unknown>>();
      const readmes: [string, string][] = [];
      const made: string[] = [];
      for (const row of rows) {
        const s = suggestions.get(row.id);
        if (!s || inside.has(row.id)) continue;
        if (s.state === 'ignored') {
          patches.set(row.id, { ...UNPLACE, state: 'ignored' });
          continue;
        }
        const key = suggestedPlace(cs, places, s, made);
        const patch: Record<string, unknown> = key ? placePatch(row as never, places.place(key)) : {};
        if (s.rights) patch.rights = s.rights;
        if (s.role) patch.role = s.role;
        if (!key && !s.rights && !s.role && !(s.seal && isArchive(row))) {
          skipped += 1;
          continue;
        }
        if (Object.keys(patch).length) patches.set(row.id, patch);
        if (s.readme && key?.startsWith('fd:')) readmes.push([key.slice(3), row.id]);
      }
      const accepted = new Set([...patches.keys(), ...seals]).size;
      cs.setSummary(summary('整理台：按建议确认 {n} 个文件', { n: accepted }));
      applyPatches(cs, patches);
      const placed = [...patches.values()].filter((p) => p.state !== 'ignored');
      markEditionsCollected(cs, places, placed.map((p) => p.edition_id as string | null));
      created = made.map((id) => {
        const e = places.editions.get(id)!;
        return `${places.releaseLabel(e.release_id)} / ${places.editionLabel(e, t)}`;
      });
      for (const [folder, file] of readmes) {
        const f = places.folders.get(folder);
        if (f && !f.readme_file_id) {
          cs.updateKnown('folder', { id: folder }, { readme_file_id: null }, { readme_file_id: file });
          f.readme_file_id = file;
        }
      }
      if (seals.length) {
        const r = await sealArchives(actor, seals, true, cs);
        sealed = { archives: r.archives, hidden: r.hidden };
        refused = r.refused;
      }
      placedCount = placed.length;
      break;
    }
    case 'rights': {
      if (!isOneOf(RIGHTS, a.rights)) throw new UserError('请选择权属');
      const rows = await visible('id, sealed_in');
      cs = new ChangeSet(database, actor, summary('整理台：{n} 个文件设为「{rights}」', { n: rows.length, rights: RIGHTS_LABELS[a.rights] }));
      cs.updateFiles(rows.map((r) => r.id), { rights: a.rights });
      break;
    }
    case 'ignore': {
      const rows = await visible('id, sealed_in');
      cs = new ChangeSet(database, actor, summary('整理台：忽略 {n} 个文件', { n: rows.length }));
      cs.updateFiles(rows.map((r) => r.id), { ...UNPLACE, state: 'ignored' });
      break;
    }
    case 'reset': {
      const rows = await visible('id, sealed_in');
      cs = new ChangeSet(database, actor, summary('整理台：{n} 个文件退回待整理', { n: rows.length }));
      cs.updateFiles(rows.map((r) => r.id), { ...UNPLACE, state: 'inbox', role: null, rights: 'unknown', dup_of: null });
      break;
    }
    case 'dup': {
      const plan = await planDuplicates(ids);
      skipped = plan.skipped;
      const marked = [...plan.keepers.values()].reduce((n, list) => n + list.length, 0);
      cs = new ChangeSet(database, actor, summary('整理台：{n} 个文件标为重复', { n: marked }));
      for (const [keeper, list] of plan.keepers) cs.updateFiles(list, { ...UNPLACE, dup_of: keeper, state: 'ignored' });
      break;
    }
  }
  const changed = await cs.commit();
  return { summary: cs.summary, changed, skipped, lowConfidence, batchId: changed ? cs.batchId : null, placed: placedCount, sealed, refused, created, noType };
}

/**
 * A file's name as the 整理台 shows it and downloads give it. The original name stays (it is where the
 * file came from, and what the next import matches): a rename sets the download name.
 */
export function checkFileName(raw: string, file: { name: string; ext: string }): string {
  const name = raw.normalize('NFC').trim();
  if (!name) return file.name;
  if (name.length > 200) throw new UserError('文件名太长（最多 200 个字符）');
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new UserError('文件名不能包含 \\ / : * ? " < > | 或控制字符：{name}', { name });
  if (file.ext && !name.toLowerCase().endsWith(`.${file.ext.toLowerCase()}`)) throw new UserError('「{name}」：扩展名不能改（应以 .{ext} 结尾）', { name, ext: file.ext });
  return name;
}

async function renameFiles(actor: string, names: [string, string][]): Promise<ActionResult> {
  type R = { id: string; name: string; ext: string; download_name: string | null; folder_id: string | null; sealed_in: string | null };
  const rows = await loadRows<R>('id, name, ext, download_name, folder_id, sealed_in', names.map(([id]) => id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const shown = new Map<string, string>(); // file → its name after the rename
  const patches = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  for (const [id, raw] of names) {
    const row = byId.get(id);
    if (!row || row.sealed_in) {
      skipped += 1;
      continue;
    }
    const name = checkFileName(raw, row);
    const next = name === row.name ? null : name;
    shown.set(id, name);
    if ((row.download_name ?? null) !== next) patches.set(id, { download_name: next });
  }
  // Two files of one folder may not end up with the same name (downloads and zips would clash).
  const folders = [...new Set([...shown.keys()].map((id) => byId.get(id)!.folder_id).filter((f): f is string => !!f))];
  if (folders.length) {
    const { results } = await db()
      .prepare('SELECT id, folder_id, coalesce(download_name, name) AS shown FROM files WHERE folder_id IN (SELECT value FROM json_each(?)) AND sealed_in IS NULL')
      .bind(JSON.stringify(folders))
      .all<{ id: string; folder_id: string; shown: string }>();
    const taken = new Map<string, string[]>();
    for (const r of results) {
      const key = `${r.folder_id}/${(shown.get(r.id) ?? r.shown).toLowerCase()}`;
      taken.set(key, [...(taken.get(key) ?? []), r.id]);
    }
    for (const [id, name] of shown) {
      const folder = byId.get(id)!.folder_id;
      if (folder && (taken.get(`${folder}/${name.toLowerCase()}`)?.length ?? 0) > 1) throw new UserError('同一个文件夹里已有叫「{name}」的文件', { name });
    }
  }
  const [first] = [...patches.keys()];
  if (!first) return { summary: summary('没有改动'), changed: 0, skipped, lowConfidence: 0, batchId: null };
  const cs = new ChangeSet(db(), actor, patches.size === 1
    ? summary('文件改名：{from} → {to}', { from: byId.get(first)!.download_name ?? byId.get(first)!.name, to: shown.get(first)! })
    : summary('{n} 个文件改名', { n: patches.size }));
  cs.patchFiles(patches);
  const changed = await cs.commit();
  return { summary: cs.summary, changed, skipped, lowConfidence: 0, batchId: changed ? cs.batchId : null };
}

async function loadRows<R>(columns: string, ids: string[]): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const { results } = await db()
      .prepare(`SELECT ${columns} FROM files WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids.slice(i, i + 2000)))
      .all<R>();
    out.push(...results);
  }
  return out;
}

export function parseInboxAction(form: FormData): InboxAction {
  const action = String(form.get('action') ?? '');
  switch (action) {
    case 'accept':
    case 'ignore':
    case 'reset':
    case 'dup':
    case 'seal':
    case 'unseal':
    case 'delete':
    case 'discard':
      return { action };
    case 'note':
      return { action, note: String(form.get('note') ?? '') };
    case 'rename': {
      let names: unknown;
      try {
        names = JSON.parse(String(form.get('names') ?? '[]'));
      } catch {
        names = null;
      }
      if (!Array.isArray(names) || names.length === 0 || names.length > 5000) throw new UserError('没有要改名的文件');
      return { action, names: names.map((pair) => [String(pair?.[0] ?? ''), String(pair?.[1] ?? '')] as [string, string]) };
    }
    case 'move': {
      const target = String(form.get('target') ?? '');
      if (!target) throw new UserError('请选择要移到的位置');
      const keep = form.get('keep');
      const newFolder = String(form.get('new_folder') ?? '').trim();
      return { action, target, keep: keep === null || keep === '__none__' ? null : String(keep), newFolder: newFolder || null };
    }
    case 'rights':
      return { action, rights: String(form.get('rights_value') ?? '') };
    default:
      throw new UserError('未知的操作');
  }
}

interface DupCandidate {
  id: string;
  sha256: string | null;
  pcm_md5: string | null;
  state: string;
  origin: string;
  member_of: string | null;
  sealed_in: string | null;
  dir: string;
  name: string;
  size: number;
}

/** Which copy to keep: one already filed, then a loose 合辑 file, then the largest, then the shortest path. */
function keeperRank(f: DupCandidate): (number | string)[] {
  const filed = f.state === 'classified' || f.state === 'published' ? 0 : f.state === 'inbox' ? 1 : 2;
  return [f.sealed_in ? 1 : 0, filed, f.origin === 'nas' && !f.member_of ? 0 : 1, -f.size, `${f.dir}/${f.name}`.length, f.id];
}

export function bestCopy<F extends DupCandidate>(list: F[]): F {
  return [...list].sort((a, b) => {
    const x = keeperRank(a);
    const y = keeperRank(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  })[0];
}

const DUP_COLUMNS = 'id, sha256, pcm_md5, state, origin, member_of, sealed_in, dir, name, size';

/**
 * 「标为重复」: every selected file that has another copy (same SHA-256, else the same decoded audio)
 * points to the copy kept and is ignored. When all copies are selected, the best one is kept.
 */
export async function planDuplicates(ids: string[]): Promise<{ keepers: Map<string, string[]>; skipped: number }> {
  const selected = (await loadRows<DupCandidate>(DUP_COLUMNS, ids)).filter((f) => !f.sealed_in);
  const shas = [...new Set(selected.map((f) => f.sha256).filter(Boolean))] as string[];
  const pcms = [...new Set(selected.map((f) => f.pcm_md5).filter(Boolean))] as string[];
  const [bySha, byPcm] = await Promise.all([
    shas.length
      ? db().prepare(`SELECT ${DUP_COLUMNS} FROM files WHERE sha256 IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(shas)).all<DupCandidate>()
      : { results: [] as DupCandidate[] },
    pcms.length
      ? db().prepare(`SELECT ${DUP_COLUMNS} FROM files WHERE pcm_md5 IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pcms)).all<DupCandidate>()
      : { results: [] as DupCandidate[] },
  ]);
  const chosen = new Set(ids);
  const keepers = new Map<string, string[]>();
  let skipped = ids.length - selected.length;
  const groupOf = (rows: DupCandidate[], key: (f: DupCandidate) => string | null) => {
    const m = new Map<string, DupCandidate[]>();
    for (const f of rows) {
      const k = key(f);
      if (k) m.set(k, [...(m.get(k) ?? []), f]);
    }
    return m;
  };
  const shaGroups = groupOf(bySha.results, (f) => f.sha256);
  const pcmGroups = groupOf(byPcm.results, (f) => f.pcm_md5);
  for (const f of selected) {
    const group = (f.sha256 && (shaGroups.get(f.sha256)?.length ?? 0) > 1 ? shaGroups.get(f.sha256) : null)
      ?? (f.pcm_md5 && (pcmGroups.get(f.pcm_md5)?.length ?? 0) > 1 ? pcmGroups.get(f.pcm_md5) : null);
    if (!group) {
      skipped += 1;
      continue;
    }
    const others = group.filter((g) => !chosen.has(g.id));
    const keeper = bestCopy(others.length ? others : group);
    if (keeper.id === f.id) continue; // the one kept among the selected
    keepers.set(keeper.id, [...(keepers.get(keeper.id) ?? []), f.id]);
  }
  return { keepers, skipped };
}

export interface DupGroup {
  key: string;
  files: (DupCandidate & { place: string | null; release_id: string | null; edition_id: string | null; folder_id: string | null; dup_of: string | null })[];
  keeper: string;
}

/**
 * Groups of visible files with the same content (or, by='audio', the same decoded audio in different
 * files), largest first, with the copy 「标为重复」 would keep.
 */
export async function duplicateGroups(by: 'content' | 'audio', page: number, size = 40): Promise<{ groups: DupGroup[]; total: number }> {
  const key = by === 'content' ? 'sha256' : 'pcm_md5';
  const database = db();
  const where = `${key} IS NOT NULL AND sealed_in IS NULL AND state != 'ignored'`;
  const having = by === 'content' ? 'count(*) > 1' : 'count(DISTINCT sha256) > 1';
  const [totalRow, keys] = await database.batch([
    database.prepare(`SELECT count(*) AS n FROM (SELECT ${key} FROM files WHERE ${where} GROUP BY ${key} HAVING ${having})`),
    database
      .prepare(`SELECT ${key} AS k, count(*) AS n, max(size) AS size FROM files WHERE ${where} GROUP BY ${key} HAVING ${having} ORDER BY n DESC, size DESC LIMIT ? OFFSET ?`)
      .bind(size, (page - 1) * size),
  ]);
  const list = (keys.results as { k: string }[]).map((r) => r.k);
  if (list.length === 0) return { groups: [], total: (totalRow.results[0] as { n: number }).n };
  const { results } = await database
    .prepare(
      `SELECT ${DUP_COLUMNS}, release_id, edition_id, folder_id, dup_of FROM files
       WHERE ${key} IN (SELECT value FROM json_each(?)) AND sealed_in IS NULL AND state != 'ignored' ORDER BY dir, name`,
    )
    .bind(JSON.stringify(list))
    .all<DupGroup['files'][number]>();
  const groups = list.map((k) => {
    const files = results.filter((f) => (by === 'content' ? f.sha256 : f.pcm_md5) === k);
    return { key: k, files, keeper: bestCopy(files).id };
  });
  return { groups, total: (totalRow.results[0] as { n: number }).n };
}

/** Keep one file of each group and mark the others as its duplicates (ignored, without a place). */
export async function markDuplicateGroups(actor: string, choices: { keeper: string; others: string[] }[]): Promise<ActionResult> {
  const cs = new ChangeSet(db(), actor, summary('重复内容：{n} 个文件标为重复', { n: choices.reduce((n, c) => n + c.others.length, 0) }));
  for (const c of choices) {
    const others = c.others.filter((id) => id !== c.keeper);
    if (others.length) cs.updateFiles(others, { ...UNPLACE, dup_of: c.keeper, state: 'ignored' });
  }
  const changed = await cs.commit();
  return { summary: cs.summary, changed, skipped: 0, lowConfidence: 0, batchId: changed ? cs.batchId : null };
}
