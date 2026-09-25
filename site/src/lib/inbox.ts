import { ChangeSet } from './changes';
import { FILE_STATES, RIGHTS, RIGHTS_LABELS, SLOTS, SLOT_LABELS, isOneOf, type Slot } from './constants';
import type { DirNode } from '../components/DirTree.astro';
import { db, parseSuggestion, suggestionPatch } from './db';
import { deleteFiles, originalGone, type DeletePlan } from './deletion';
import { markCollected } from './releases';
import { summary, UserError } from './i18n';

export interface InboxFilters {
  state: string; // a file state or 'all'
  dir: string;
  q: string;
  kind: string;
  sug: '' | 'release' | 'rights' | 'none';
  release: string;
  rights: string;
  origin: '' | 'nas' | 'upload' | 'gone';
  acoustic: '' | 'any' | 'own'; // sounds like the same recording as another file (/ as one of the circle's own)
}

export function readFilters(params: URLSearchParams): InboxFilters {
  const state = params.get('state') ?? 'inbox';
  const sug = params.get('sug') ?? '';
  const origin = params.get('origin') ?? '';
  const acoustic = params.get('acoustic') ?? '';
  return {
    state: state === 'all' || isOneOf(FILE_STATES, state) ? state : 'inbox',
    dir: params.get('dir') ?? '',
    q: (params.get('q') ?? '').trim(),
    kind: params.get('kind') ?? '',
    sug: sug === 'release' || sug === 'rights' || sug === 'none' ? sug : '',
    release: params.get('release') ?? '',
    rights: isOneOf(RIGHTS, params.get('rights')) ? (params.get('rights') as string) : '',
    origin: origin === 'nas' || origin === 'upload' || origin === 'gone' ? origin : '',
    acoustic: acoustic === 'any' || acoustic === 'own' ? acoustic : '',
  };
}

export function whereClause(f: InboxFilters): { sql: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (f.state !== 'all') {
    parts.push('state = ?');
    binds.push(f.state);
  }
  if (f.dir) {
    // The folder and everything below it: 'a/b' plus every 'a/b/…' ('0' is the character after '/').
    // A range instead of LIKE: D1 refuses LIKE patterns longer than 50 bytes, and this uses the index.
    parts.push('(dir = ? OR (dir >= ? AND dir < ?))');
    binds.push(f.dir, `${f.dir}/`, `${f.dir}0`);
  }
  if (f.q) {
    parts.push("instr(lower(dir || '/' || name), lower(?)) > 0");
    binds.push(f.q);
  }
  if (f.kind) {
    parts.push('kind = ?');
    binds.push(f.kind);
  }
  if (f.release) {
    parts.push('release_id = ?');
    binds.push(f.release);
  }
  if (f.rights) {
    parts.push('rights = ?');
    binds.push(f.rights);
  }
  if (f.origin === 'nas' || f.origin === 'upload') {
    parts.push('origin = ?');
    binds.push(f.origin);
  }
  if (f.origin === 'gone') parts.push(originalGone('files'));
  if (f.acoustic) {
    // Acoustic fingerprints: e.g. the circle's tracks inside third-party compilations and game OSTs.
    const own = f.acoustic === 'own' ? "AND EXISTS (SELECT 1 FROM files o WHERE o.sha256 = CASE WHEN m.a = files.sha256 THEN m.b ELSE m.a END AND o.rights = 'own')" : '';
    parts.push(`EXISTS (SELECT 1 FROM acoustic_matches m WHERE (m.a = files.sha256 OR m.b = files.sha256) ${own})`);
  }
  const sugRelease = "json_extract(suggest, '$.release_id')";
  const sugRights = "json_extract(suggest, '$.rights')";
  const sugState = "json_extract(suggest, '$.state')";
  if (f.sug === 'release') parts.push(`${sugRelease} IS NOT NULL`);
  if (f.sug === 'rights') parts.push(`${sugRelease} IS NULL AND (${sugRights} IS NOT NULL OR ${sugState} IS NOT NULL)`);
  if (f.sug === 'none') parts.push(`${sugRelease} IS NULL AND ${sugRights} IS NULL AND ${sugState} IS NULL`);
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', binds };
}

export async function idsForFilter(f: InboxFilters): Promise<string[]> {
  const w = whereClause(f);
  const { results } = await db().prepare(`SELECT id FROM files ${w.sql}`).bind(...w.binds).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function dirTree(state: string): Promise<{ nodes: DirNode[]; total: number }> {
  const stmt =
    state === 'all'
      ? db().prepare('SELECT dir, count(*) AS n FROM files GROUP BY dir')
      : db().prepare('SELECT dir, count(*) AS n FROM files WHERE state = ? GROUP BY dir').bind(state);
  const { results } = await stmt.all<{ dir: string; n: number }>();

  interface Build { name: string; path: string; n: number; children: Map<string, Build> }
  const root: Build = { name: '', path: '', n: 0, children: new Map() };
  for (const { dir, n } of results) {
    root.n += n;
    if (!dir) continue;
    let node = root;
    const parts = dir.split('/');
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), n: 0, children: new Map() };
        node.children.set(part, child);
      }
      child.n += n;
      node = child;
    });
  }
  const finish = (b: Build): DirNode[] =>
    [...b.children.values()]
      .sort((a, c) => a.name.localeCompare(c.name, 'ja'))
      .map((c) => ({ name: c.name, path: c.path, n: c.n, children: finish(c) }));
  return { nodes: finish(root), total: root.n };
}

async function inChunks<T>(ids: string[], size: number, fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

async function select<T>(sql: string, ids: string[]): Promise<T[]> {
  return inChunks(ids, 90, async (chunk) => {
    const { results } = await db()
      .prepare(sql.replace('(?)', `(${chunk.map(() => '?').join(', ')})`))
      .bind(...chunk)
      .all<T>();
    return results;
  });
}

/** Suggestions below this confidence are only accepted one file at a time (on the file page). */
export const MIN_BATCH_CONFIDENCE = 0.5;

export type InboxAction =
  | { action: 'accept' }
  | { action: 'assign'; release: string; slot: Slot | null }
  | { action: 'rights'; rights: string }
  | { action: 'ignore' }
  | { action: 'reset' }
  | { action: 'dup' }
  | { action: 'delete' };

export interface ActionResult {
  summary: string;
  changed: number;
  skipped: number;
  lowConfidence: number;
  kept?: DeletePlan; // for deletions: why some files were not deleted (keptMessage)
}

/** Apply an 整理台 batch action to the given files. Throws with a user-facing message on bad input. */
export async function applyInboxAction(actor: string, ids: string[], a: InboxAction): Promise<ActionResult> {
  const database = db();
  let skipped = 0;
  let lowConfidence = 0;
  let cs: ChangeSet;

  if (a.action === 'delete') {
    const r = await deleteFiles(database, actor, ids);
    return { summary: r.count ? r.summary : summary('没有删除文件'), changed: r.count, skipped: 0, lowConfidence: 0, kept: r };
  }

  switch (a.action) {
    case 'accept': {
      const rows = await select<{ id: string; suggest: string | null }>('SELECT id, suggest FROM files WHERE id IN (?)', ids);
      const groups = new Map<string, { patch: Record<string, string | null>; ids: string[] }>();
      for (const row of rows) {
        const suggestion = parseSuggestion(row.suggest);
        if (suggestion && suggestion.confidence < MIN_BATCH_CONFIDENCE) {
          lowConfidence += 1;
          continue;
        }
        const patch = suggestionPatch(suggestion);
        if (!patch) {
          skipped += 1;
          continue;
        }
        const key = JSON.stringify(patch);
        const group = groups.get(key) ?? { patch, ids: [] };
        group.ids.push(row.id);
        groups.set(key, group);
      }
      const accepted = [...groups.values()].reduce((n, g) => n + g.ids.length, 0);
      cs = new ChangeSet(database, actor, summary('整理台：按建议确认 {n} 个文件', { n: accepted }));
      for (const g of groups.values()) cs.updateFiles(g.ids, g.patch);
      await markCollected(cs, [...groups.values()].map((g) => [g.patch.release_id, g.patch.slot] as const));
      break;
    }
    case 'assign': {
      const release = await database
        .prepare('SELECT id, catalog_no, title FROM releases WHERE id = ?')
        .bind(a.release)
        .first<{ id: string; catalog_no: string | null; title: string }>();
      if (!release) throw new UserError('请选择要归入的作品');
      const label = release.catalog_no ?? release.title;
      cs = new ChangeSet(database, actor, a.slot ? summary('整理台：{n} 个文件归入 {release} / {slot}', { n: ids.length, release: label, slot: SLOT_LABELS[a.slot] }) : summary('整理台：{n} 个文件归入 {release}', { n: ids.length, release: label }));
      // Filing a file under a release makes it the circle's own unless it already has other rights.
      const unknown = new Set(
        (await select<{ id: string }>("SELECT id FROM files WHERE rights = 'unknown' AND id IN (?)", ids)).map((r) => r.id),
      );
      const patch = { release_id: release.id, slot: a.slot, state: 'classified' };
      cs.updateFiles(ids.filter((i) => unknown.has(i)), { ...patch, rights: 'own' });
      cs.updateFiles(ids.filter((i) => !unknown.has(i)), patch);
      await markCollected(cs, [[release.id, a.slot]]);
      // A file moved to another release no longer belongs to a track of the old one.
      const moved = await select<{ id: string }>(
        `SELECT id FROM files WHERE track_id IS NOT NULL AND id IN (?) AND track_id NOT IN (SELECT id FROM tracks WHERE release_id = '${release.id.replace(/'/g, "''")}')`,
        ids,
      );
      cs.updateFiles(moved.map((r) => r.id), { track_id: null });
      break;
    }
    case 'rights': {
      if (!isOneOf(RIGHTS, a.rights)) throw new UserError('请选择权属');
      cs = new ChangeSet(database, actor, summary('整理台：{n} 个文件设为「{rights}」', { n: ids.length, rights: RIGHTS_LABELS[a.rights] }));
      cs.updateFiles(ids, { rights: a.rights, state: 'classified' });
      break;
    }
    case 'ignore':
      cs = new ChangeSet(database, actor, summary('整理台：忽略 {n} 个文件', { n: ids.length }));
      cs.updateFiles(ids, { state: 'ignored' });
      break;
    case 'reset':
      cs = new ChangeSet(database, actor, summary('整理台：{n} 个文件退回待整理', { n: ids.length }));
      cs.updateFiles(ids, { state: 'inbox', release_id: null, slot: null, track_id: null, role: null, rights: 'unknown', dup_of: null });
      break;
    case 'dup': {
      const plan = await planDuplicates(ids);
      skipped = plan.skipped;
      const marked = [...plan.keepers.values()].reduce((n, list) => n + list.length, 0);
      cs = new ChangeSet(database, actor, summary('整理台：{n} 个文件标为重复', { n: marked }));
      for (const [keeper, list] of plan.keepers) cs.updateFiles(list, { dup_of: keeper, state: 'ignored' });
      break;
    }
  }
  const changed = await cs.commit();
  return { summary: cs.summary, changed, skipped, lowConfidence };
}

export function parseInboxAction(form: FormData): InboxAction {
  const action = String(form.get('action') ?? '');
  switch (action) {
    case 'accept':
    case 'ignore':
    case 'reset':
    case 'dup':
    case 'delete':
      return { action };
    case 'assign': {
      const slot = String(form.get('slot') ?? '');
      if (slot && !isOneOf(SLOTS, slot)) throw new UserError('未知的版本栏位');
      return { action, release: String(form.get('release') ?? ''), slot: slot ? (slot as Slot) : null };
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
  dir: string;
  name: string;
  size: number;
}

/** Which copy to keep: one already filed, then a loose 合辑 file, then the largest, then the shortest path. */
function keeperRank(f: DupCandidate): (number | string)[] {
  const filed = f.state === 'classified' || f.state === 'published' ? 0 : f.state === 'inbox' ? 1 : 2;
  return [filed, f.origin === 'nas' && !f.member_of ? 0 : 1, -f.size, `${f.dir}/${f.name}`.length, f.id];
}

function best(list: DupCandidate[]): DupCandidate {
  return [...list].sort((a, b) => {
    const x = keeperRank(a);
    const y = keeperRank(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  })[0];
}

/**
 * 「标为重复」: every selected file that has another copy (same SHA-256, else the same decoded audio)
 * points to the copy kept and is ignored. When all copies are selected, the best one is kept.
 */
export async function planDuplicates(ids: string[]): Promise<{ keepers: Map<string, string[]>; skipped: number }> {
  const selected = await select<DupCandidate>(
    'SELECT id, sha256, pcm_md5, state, origin, member_of, dir, name, size FROM files WHERE id IN (?)', ids,
  );
  const shas = [...new Set(selected.map((f) => f.sha256).filter(Boolean))] as string[];
  const pcms = [...new Set(selected.map((f) => f.pcm_md5).filter(Boolean))] as string[];
  const cols = 'id, sha256, pcm_md5, state, origin, member_of, dir, name, size';
  const [bySha, byPcm] = await Promise.all([
    shas.length
      ? db().prepare(`SELECT ${cols} FROM files WHERE sha256 IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(shas)).all<DupCandidate>()
      : { results: [] as DupCandidate[] },
    pcms.length
      ? db().prepare(`SELECT ${cols} FROM files WHERE pcm_md5 IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(pcms)).all<DupCandidate>()
      : { results: [] as DupCandidate[] },
  ]);
  const chosen = new Set(ids);
  const keepers = new Map<string, string[]>();
  let skipped = 0;
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
    const keeper = best(others.length ? others : group);
    if (keeper.id === f.id) continue; // the one kept among the selected
    keepers.set(keeper.id, [...(keepers.get(keeper.id) ?? []), f.id]);
  }
  return { keepers, skipped };
}
