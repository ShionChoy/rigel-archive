import { ChangeSet } from './changes';
import { FILE_STATES, RIGHTS, RIGHTS_LABELS, isOneOf, type Slot } from './constants';
import type { DirNode } from '../components/DirTree.astro';
import { db, parseSuggestion, type Suggestion } from './db';
import { deleteFiles, originalGone, type DeletePlan } from './deletion';
import { newId } from './ids';
import {
  Places, TOP, UNPLACED, VISIBLE, applyPatches, ensureFolder, locationWhere, markEditionsCollected, moveFiles,
  placePatch, sealArchives,
} from './locations';
import { markCollected } from './releases';
import { summary, UserError, type T } from './i18n';

export interface InboxFilters {
  state: string; // a file state or 'all'
  loc: string; // a place in the archive tree (era:, rel:, ed:, fd:, unplaced) or ''
  dir: string; // an original folder
  q: string;
  kind: string;
  sug: '' | 'release' | 'place' | 'rights' | 'seal' | 'none';
  rights: string;
  origin: '' | 'nas' | 'upload' | 'gone';
  acoustic: '' | 'any' | 'own'; // sounds like the same recording as another file (/ as one of the circle's own)
  archives: '' | 'only' | 'sealed';
}

export function readFilters(params: URLSearchParams): InboxFilters {
  const state = params.get('state') ?? 'inbox';
  const sug = params.get('sug') ?? '';
  const origin = params.get('origin') ?? '';
  const acoustic = params.get('acoustic') ?? '';
  const archives = params.get('archives') ?? '';
  // Links from before the archive tree filter by release.
  const release = params.get('release');
  return {
    state: state === 'all' || isOneOf(FILE_STATES, state) ? state : 'inbox',
    loc: params.get('loc') ?? (release ? `rel:${release}` : ''),
    dir: params.get('dir') ?? '',
    q: (params.get('q') ?? '').trim(),
    kind: params.get('kind') ?? '',
    sug: isOneOf(['release', 'place', 'rights', 'seal', 'none'] as const, sug) ? sug : '',
    rights: isOneOf(RIGHTS, params.get('rights')) ? (params.get('rights') as string) : '',
    origin: origin === 'nas' || origin === 'upload' || origin === 'gone' ? origin : '',
    acoustic: acoustic === 'any' || acoustic === 'own' ? acoustic : '',
    archives: archives === 'only' || archives === 'sealed' ? archives : '',
  };
}

const SUG = (field: string) => `json_extract(files.suggest, '$.${field}')`;

export function whereClause(f: InboxFilters, places: Places): { sql: string; binds: unknown[] } {
  const parts: string[] = [VISIBLE];
  const binds: unknown[] = [];
  if (f.state !== 'all') {
    parts.push('files.state = ?');
    binds.push(f.state);
  }
  if (f.loc && places.exists(f.loc)) {
    const w = locationWhere(places, f.loc);
    parts.push(w.sql);
    binds.push(...w.binds);
  }
  if (f.dir) {
    // The folder and everything below it: 'a/b' plus every 'a/b/…' ('0' is the character after '/').
    // A range instead of LIKE: D1 refuses LIKE patterns longer than 50 bytes, and this uses the index.
    parts.push('(files.dir = ? OR (files.dir >= ? AND files.dir < ?))');
    binds.push(f.dir, `${f.dir}/`, `${f.dir}0`);
  }
  if (f.q) {
    parts.push("instr(lower(files.dir || '/' || files.name), lower(?)) > 0");
    binds.push(f.q);
  }
  if (f.kind) {
    parts.push('files.kind = ?');
    binds.push(f.kind);
  }
  if (f.rights) {
    parts.push('files.rights = ?');
    binds.push(f.rights);
  }
  if (f.origin === 'nas' || f.origin === 'upload') {
    parts.push('files.origin = ?');
    binds.push(f.origin);
  }
  if (f.origin === 'gone') parts.push(originalGone('files'));
  if (f.acoustic) {
    // Acoustic fingerprints: e.g. the circle's tracks inside third-party compilations and game OSTs.
    const own = f.acoustic === 'own' ? "AND EXISTS (SELECT 1 FROM files o WHERE o.sha256 = CASE WHEN m.a = files.sha256 THEN m.b ELSE m.a END AND o.rights = 'own')" : '';
    parts.push(`EXISTS (SELECT 1 FROM acoustic_matches m WHERE (m.a = files.sha256 OR m.b = files.sha256) ${own})`);
  }
  if (f.archives === 'only') parts.push("(files.kind IN ('archive', 'disc_image') OR json_extract(files.format, '$.archive') IS NOT NULL)");
  if (f.archives === 'sealed') parts.push('files.sealed = 1');
  const hasPlace = `(${SUG('release_id')} IS NOT NULL OR ${SUG('folder')} IS NOT NULL)`;
  if (f.sug === 'release') parts.push(`${SUG('release_id')} IS NOT NULL`);
  if (f.sug === 'place') parts.push(hasPlace);
  if (f.sug === 'seal') parts.push(`${SUG('seal')} = 1`);
  if (f.sug === 'rights') parts.push(`NOT ${hasPlace} AND (${SUG('rights')} IS NOT NULL OR ${SUG('state')} IS NOT NULL)`);
  if (f.sug === 'none') parts.push(`files.suggest IS NULL`);
  return { sql: `WHERE ${parts.join(' AND ')}`, binds };
}

export async function idsForFilter(f: InboxFilters, places: Places): Promise<string[]> {
  const w = whereClause(f, places);
  const { results } = await db().prepare(`SELECT id FROM files ${w.sql}`).bind(...w.binds).all<{ id: string }>();
  return results.map((r) => r.id);
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
  | { action: 'delete' };

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
}

const UNPLACE = { release_id: null, edition_id: null, folder_id: null, slot: null, track_id: null };

/** The edition of a release's slot with this name, made in `cs` when missing. */
export function ensureEdition(cs: ChangeSet, places: Places, releaseId: string, slot: Slot, name: string, catalog: string | null): string {
  const found = [...places.editions.values()].find((e) => e.release_id === releaseId && e.slot === slot && e.name === name);
  if (found) return found.id;
  const id = newId('e');
  const row = { id, release_id: releaseId, slot, name, catalog_no: catalog, release_date: null, status: 'collected' as const, sort: 0, is_default: 0 };
  cs.queueCreate('edition', { ...row, source: null, based_on: null, track_count: null, album_title: null, cover_file_id: null, external_ids: '{}', note: null });
  places.addEdition(row);
  return id;
}

/** Where a suggestion puts a file (making the edition or folders it names), or null for nowhere. */
export function suggestedPlace(cs: ChangeSet, places: Places, s: Suggestion): string | null {
  const folder = s.folder ? s.folder.split('/').filter(Boolean) : [];
  if (s.place && places.exists(s.place) && s.place !== UNPLACED) {
    if (folder.length) return `fd:${ensureFolder(cs, places, s.place, folder)}`;
    return s.place.startsWith('era:') || s.place === TOP ? null : s.place;
  }
  if (s.release_id && places.releases.has(s.release_id)) {
    let key = `rel:${s.release_id}`;
    if (s.slot) key = `ed:${ensureEdition(cs, places, s.release_id, s.slot, s.edition ?? '', s.edition_catalog ?? null)}`;
    if (folder.length) key = `fd:${ensureFolder(cs, places, key, folder)}`;
    return key;
  }
  if (folder.length) {
    const under = s.era_id && places.eras.has(s.era_id) ? `era:${s.era_id}` : TOP;
    return `fd:${ensureFolder(cs, places, under, folder)}`;
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
  let refused: string[] | undefined;
  let cs: ChangeSet;

  if (a.action === 'delete') {
    const r = await deleteFiles(database, actor, ids);
    return { summary: r.count ? r.summary : summary('没有删除文件'), changed: r.count, skipped: 0, lowConfidence: 0, kept: r, batchId: null };
  }
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
      const patches = new Map<string, Record<string, unknown>>();
      const readmes: [string, string][] = [];
      for (const row of rows) {
        const s = suggestions.get(row.id);
        if (!s || inside.has(row.id)) continue;
        if (s.state === 'ignored') {
          patches.set(row.id, { ...UNPLACE, state: 'ignored' });
          continue;
        }
        const key = suggestedPlace(cs, places, s);
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
      await markCollected(cs, placed.map((p) => [p.release_id as string | null, p.slot as string | null] as const));
      markEditionsCollected(cs, places, placed.map((p) => p.edition_id as string | null));
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
  return { summary: cs.summary, changed, skipped, lowConfidence, batchId: changed ? cs.batchId : null, placed: placedCount, sealed, refused };
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
      return { action };
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
