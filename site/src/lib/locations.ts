// Where files sit in the archive (归档位置): the tree of eras, releases, editions and the folders the
// admins make; moving files; folders; archives kept whole (整体收藏).
//
// A file's place is three columns: folder_id (a folder, which brings its release and edition), else
// edition_id (with release_id), else release_id alone (the release's related material). Unplaced files
// (未归档) have none of them. The original path (dir) never changes: it is where the file came from.
//
// Places are addressed by keys: era:<id>, rel:<id>, ed:<id>, fd:<id>; «top» is the top level (folders
// made there), «unplaced» the files without a place.

import { ChangeSet } from './changes';
import { SLOTS, SLOT_LABELS, type Slot } from './constants';
import { db, type EditionRow, type FolderRow } from './db';
import { N_, summary, UserError, type T } from './i18n';
import { newId } from './ids';
import { markCollected } from './releases';

export interface EraInfo { id: string; name: string; sort: number }
export interface ReleaseInfo { id: string; era_id: string; catalog_no: string | null; title: string; release_date: string | null }
export type EditionInfo = Pick<EditionRow, 'id' | 'release_id' | 'slot' | 'name' | 'catalog_no' | 'release_date' | 'status' | 'sort' | 'is_default'>;
export type FolderInfo = Pick<FolderRow, 'id' | 'parent_id' | 'era_id' | 'release_id' | 'edition_id' | 'name' | 'description' | 'readme_file_id' | 'sort'>;

/** What filing a file somewhere writes into it. */
export interface Place {
  release_id: string | null;
  edition_id: string | null;
  folder_id: string | null;
  slot: Slot | null;
}

export const TOP = 'top';
export const UNPLACED = 'unplaced';

/** SQL (on `files`): shown in the 整理台 at all, i.e. not inside an archive kept whole. */
export const VISIBLE = 'files.sealed_in IS NULL';
/** SQL (on `files`): has a place in the archive. */
export const PLACED = '(files.release_id IS NOT NULL OR files.folder_id IS NOT NULL)';
/** SQL (on `files`): still to be organized: no place, not ignored, not hidden in a kept-whole archive. */
export const UNPLACED_SQL = `(${VISIBLE} AND files.release_id IS NULL AND files.folder_id IS NULL AND files.state != 'ignored')`;
/** SQL (on `files`): an archive or disc image, which can be kept whole. */
export const IS_ARCHIVE = "(files.kind IN ('archive', 'disc_image') OR json_extract(files.format, '$.archive') IS NOT NULL)";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ja');

/** Every era, release, edition and folder, loaded once per request. */
export class Places {
  readonly eras = new Map<string, EraInfo>();
  readonly releases = new Map<string, ReleaseInfo>();
  readonly editions = new Map<string, EditionInfo>();
  readonly folders = new Map<string, FolderInfo>();

  static async load(database: D1Database = db()): Promise<Places> {
    const [eras, releases, editions, folders] = await database.batch([
      database.prepare('SELECT id, name, sort FROM eras ORDER BY sort'),
      database.prepare('SELECT id, era_id, catalog_no, title, release_date FROM releases'),
      database.prepare('SELECT id, release_id, slot, name, catalog_no, release_date, status, sort, is_default FROM editions'),
      database.prepare('SELECT id, parent_id, era_id, release_id, edition_id, name, description, readme_file_id, sort FROM folders'),
    ]);
    const p = new Places();
    for (const r of eras.results as EraInfo[]) p.eras.set(r.id, r);
    for (const r of releases.results as ReleaseInfo[]) p.releases.set(r.id, r);
    for (const r of editions.results as EditionInfo[]) p.editions.set(r.id, r);
    for (const r of folders.results as FolderInfo[]) p.folders.set(r.id, r);
    return p;
  }

  /** The key of a file's place, or null when it has none. */
  keyOf(f: { release_id: string | null; edition_id?: string | null; folder_id?: string | null }): string | null {
    if (f.folder_id && this.folders.has(f.folder_id)) return `fd:${f.folder_id}`;
    if (f.edition_id && this.editions.has(f.edition_id)) return `ed:${f.edition_id}`;
    if (f.release_id && this.releases.has(f.release_id)) return `rel:${f.release_id}`;
    return null;
  }

  exists(key: string): boolean {
    const [kind, id] = split(key);
    if (key === TOP || key === UNPLACED) return true;
    if (kind === 'era') return this.eras.has(id);
    if (kind === 'rel') return this.releases.has(id);
    if (kind === 'ed') return this.editions.has(id);
    if (kind === 'fd') return this.folders.has(id);
    return false;
  }

  /** The node a place hangs under in the tree (null at the top). */
  parentOf(key: string): string | null {
    const [kind, id] = split(key);
    if (kind === 'rel') {
      const r = this.releases.get(id);
      return r ? `era:${r.era_id}` : null;
    }
    if (kind === 'ed') {
      const e = this.editions.get(id);
      return e ? `rel:${e.release_id}` : null;
    }
    if (kind === 'fd') {
      const f = this.folders.get(id);
      if (!f) return null;
      if (f.parent_id) return `fd:${f.parent_id}`;
      if (f.edition_id) return `ed:${f.edition_id}`;
      if (f.release_id) return `rel:${f.release_id}`;
      if (f.era_id) return `era:${f.era_id}`;
    }
    return null;
  }

  /** The keys from the top down to this place. */
  chain(key: string): string[] {
    const out: string[] = [];
    for (let k: string | null = key; k && out.length < 50; k = this.parentOf(k)) out.unshift(k);
    return out;
  }

  releaseLabel(id: string): string {
    const r = this.releases.get(id);
    if (!r) return id;
    return r.catalog_no ? `${r.catalog_no} ${r.title}` : r.title;
  }

  editionLabel(e: Pick<EditionInfo, 'slot' | 'name'>, t: T): string {
    const slot = t(SLOT_LABELS[e.slot]);
    return e.name ? `${slot} · ${e.name}` : slot;
  }

  /** The name of one node. */
  name(key: string, t: T): string {
    const [kind, id] = split(key);
    if (key === TOP) return t('顶层');
    if (key === UNPLACED) return t('未归档');
    if (kind === 'era') return this.eras.get(id)?.name ?? id;
    if (kind === 'rel') return this.releaseLabel(id);
    if (kind === 'ed') {
      const e = this.editions.get(id);
      return e ? this.editionLabel(e, t) : id;
    }
    if (kind === 'fd') return this.folders.get(id)?.name ?? id;
    return key;
  }

  /** «Rigël Theatre / RTCD-004 Lengsel … / CD 抓轨 · 再版» */
  path(key: string, t: T): string {
    return this.chain(key).map((k) => this.name(k, t)).join(' / ');
  }

  /** What filing a file at this place writes. Eras and the top only hold folders. */
  place(key: string): Place {
    const [kind, id] = split(key);
    if (kind === 'rel' && this.releases.has(id)) return { release_id: id, edition_id: null, folder_id: null, slot: null };
    if (kind === 'ed') {
      const e = this.editions.get(id);
      if (e) return { release_id: e.release_id, edition_id: e.id, folder_id: null, slot: e.slot };
    }
    if (kind === 'fd') {
      const f = this.folders.get(id);
      if (f) {
        const e = f.edition_id ? this.editions.get(f.edition_id) : undefined;
        return { release_id: f.release_id, edition_id: f.edition_id, folder_id: f.id, slot: e?.slot ?? null };
      }
    }
    if (kind === 'era' || key === TOP) throw new UserError('文件不能直接放在名义或顶层，请放进作品、版本或文件夹');
    throw new UserError('找不到这个位置');
  }

  /** The columns of a folder made directly under this place. */
  anchorOf(key: string): Pick<FolderRow, 'parent_id' | 'era_id' | 'release_id' | 'edition_id'> {
    const [kind, id] = split(key);
    if (key === TOP) return { parent_id: null, era_id: null, release_id: null, edition_id: null };
    if (kind === 'era' && this.eras.has(id)) return { parent_id: null, era_id: id, release_id: null, edition_id: null };
    if (kind === 'rel' && this.releases.has(id)) return { parent_id: null, era_id: null, release_id: id, edition_id: null };
    if (kind === 'ed') {
      const e = this.editions.get(id);
      if (e) return { parent_id: null, era_id: null, release_id: e.release_id, edition_id: e.id };
    }
    if (kind === 'fd') {
      const f = this.folders.get(id);
      if (f) return { parent_id: f.id, era_id: f.era_id, release_id: f.release_id, edition_id: f.edition_id };
    }
    throw new UserError('找不到这个位置');
  }

  /** The folders directly under a place. */
  childFolders(key: string): FolderInfo[] {
    const [kind, id] = split(key);
    return [...this.folders.values()].filter((f) => {
      if (kind === 'fd') return f.parent_id === id;
      if (f.parent_id) return false;
      if (kind === 'ed') return f.edition_id === id;
      if (f.edition_id) return false;
      if (kind === 'rel') return f.release_id === id;
      if (f.release_id) return false;
      if (kind === 'era') return f.era_id === id;
      return key === TOP && !f.era_id;
    });
  }

  /** The folder and every folder below it. */
  subtree(folderId: string): string[] {
    const out = [folderId];
    for (let i = 0; i < out.length; i += 1) {
      for (const f of this.folders.values()) if (f.parent_id === out[i]) out.push(f.id);
    }
    return out;
  }

  editionsOf(releaseId: string): EditionInfo[] {
    return [...this.editions.values()]
      .filter((e) => e.release_id === releaseId)
      .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) || a.sort - b.sort
        || (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999') || a.name.localeCompare(b.name, 'ja'));
  }

  releasesOf(eraId: string): ReleaseInfo[] {
    return [...this.releases.values()]
      .filter((r) => r.era_id === eraId)
      .sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999')
        || (a.catalog_no ?? '').localeCompare(b.catalog_no ?? '') || a.title.localeCompare(b.title, 'ja'));
  }

  /** Every place a file can be filed in, for the 「移动到…」 picker (eras and the top only hold folders). */
  options(t: T): { key: string; path: string; kind: string; depth: number }[] {
    const out: { key: string; path: string; kind: string; depth: number }[] = [];
    const walk = (key: string, depth: number) => {
      out.push({ key, path: this.path(key, t), kind: split(key)[0], depth });
      for (const child of this.childrenOf(key)) walk(child, depth + 1);
    };
    for (const era of this.eras.values()) walk(`era:${era.id}`, 0);
    for (const f of this.childFolders(TOP).sort(byName)) walk(`fd:${f.id}`, 0);
    return out;
  }

  /** The nodes directly under a node, in tree order. */
  childrenOf(key: string): string[] {
    const [kind, id] = split(key);
    const folders = this.childFolders(key).sort((a, b) => a.sort - b.sort || byName(a, b)).map((f) => `fd:${f.id}`);
    if (kind === 'era') return [...this.releasesOf(id).map((r) => `rel:${r.id}`), ...folders];
    if (kind === 'rel') return [...this.editionsOf(id).map((e) => `ed:${e.id}`), ...folders];
    return folders;
  }

  /** Add a row made in this request, so later lookups see it. */
  addFolder(f: FolderInfo) {
    this.folders.set(f.id, f);
  }

  addEdition(e: EditionInfo) {
    this.editions.set(e.id, e);
  }
}

function split(key: string): [string, string] {
  const at = key.indexOf(':');
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}

/** SQL condition (on `files`) for the files at a place and below it. */
export function locationWhere(places: Places, key: string): { sql: string; binds: unknown[] } {
  const [kind, id] = split(key);
  if (key === UNPLACED) return { sql: UNPLACED_SQL, binds: [] };
  if (kind === 'era') {
    const folders = [...places.folders.values()].filter((f) => f.era_id === id).map((f) => f.id);
    return {
      sql: '(files.release_id IN (SELECT id FROM releases WHERE era_id = ?) OR files.folder_id IN (SELECT value FROM json_each(?)))',
      binds: [id, JSON.stringify(folders)],
    };
  }
  if (kind === 'rel') return { sql: 'files.release_id = ?', binds: [id] };
  if (kind === 'ed') return { sql: 'files.edition_id = ?', binds: [id] };
  if (kind === 'fd') return { sql: 'files.folder_id IN (SELECT value FROM json_each(?))', binds: [JSON.stringify(places.subtree(id))] };
  if (key === TOP) {
    const folders = [...places.folders.values()].filter((f) => !f.era_id && !f.release_id).map((f) => f.id);
    return { sql: 'files.folder_id IN (SELECT value FROM json_each(?))', binds: [JSON.stringify(folders)] };
  }
  return { sql: '0', binds: [] };
}

// ------------------------------------------------------------------------------------------ tree

export interface LocNode {
  key: string;
  kind: 'era' | 'rel' | 'ed' | 'fd';
  name: string;
  n: number; // files at this place and below
  children: LocNode[];
  status?: string; // editions: collected / missing …
  readme?: boolean;
}

/** The archive tree with file counts (visible files that have a place). */
export async function archiveTree(places: Places, t: T): Promise<LocNode[]> {
  const { results } = await db()
    .prepare(
      `SELECT release_id, edition_id, folder_id, count(*) AS n FROM files
       WHERE ${VISIBLE} AND ${PLACED} GROUP BY release_id, edition_id, folder_id`,
    )
    .all<{ release_id: string | null; edition_id: string | null; folder_id: string | null; n: number }>();
  const direct = new Map<string, number>();
  for (const r of results) {
    const key = places.keyOf(r);
    if (key) direct.set(key, (direct.get(key) ?? 0) + r.n);
  }
  const build = (key: string): LocNode => {
    const children = places.childrenOf(key).map(build);
    const [kind, id] = split(key);
    return {
      key,
      kind: kind as LocNode['kind'],
      name: places.name(key, t),
      n: (direct.get(key) ?? 0) + children.reduce((s, c) => s + c.n, 0),
      children,
      status: kind === 'ed' ? places.editions.get(id)?.status : undefined,
      readme: kind === 'fd' ? !!places.folders.get(id)?.readme_file_id : undefined,
    };
  };
  return [
    ...[...places.eras.values()].map((e) => build(`era:${e.id}`)),
    ...places.childFolders(TOP).sort((a, b) => a.sort - b.sort || byName(a, b)).map((f) => build(`fd:${f.id}`)),
  ];
}

// ------------------------------------------------------------------------------------------ folders

const MAX_NAME = 200;

export function checkFolderName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (!name) throw new UserError('文件夹名称不能为空');
  if (name.length > MAX_NAME) throw new UserError('文件夹名称太长');
  if (name.includes('/')) throw new UserError('文件夹名称里不能有「/」');
  return name;
}

/**
 * The folder at `names` below `under` (e.g. ['游戏与模拟器'] under era:dezaemon), made in `cs` where
 * missing. Returns its id.
 */
export function ensureFolder(cs: ChangeSet, places: Places, under: string, names: string[]): string {
  let parent = under;
  let id = '';
  for (const raw of names) {
    const name = checkFolderName(raw);
    const found = places.childFolders(parent).find((f) => f.name === name);
    if (found) id = found.id;
    else {
      id = newId('fd');
      const row: FolderInfo = { id, name, description: null, readme_file_id: null, sort: 0, ...places.anchorOf(parent) };
      cs.queueCreate('folder', { ...row });
      places.addFolder(row);
    }
    parent = `fd:${id}`;
  }
  return id;
}

export async function createFolder(actor: string, under: string, rawName: string, t: T): Promise<string> {
  const places = await Places.load();
  if (!places.exists(under) || under === UNPLACED) throw new UserError('找不到这个位置');
  const name = checkFolderName(rawName);
  if (places.childFolders(under).some((f) => f.name === name)) throw new UserError('这里已经有名为「{name}」的文件夹', { name });
  const cs = new ChangeSet(db(), actor, summary('新建文件夹 {path}', { path: `${places.path(under, t)} / ${name}` }));
  const id = ensureFolder(cs, places, under, [name]);
  await cs.commit();
  return id;
}

export async function updateFolder(actor: string, id: string, patch: { name?: string; description?: string | null; readme_file_id?: string | null; sort?: number }, t: T): Promise<number> {
  const places = await Places.load();
  const folder = places.folders.get(id);
  if (!folder) throw new UserError('找不到这个文件夹');
  const next: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = checkFolderName(patch.name);
    const parent = places.parentOf(`fd:${id}`) ?? TOP;
    if (name !== folder.name && places.childFolders(parent).some((f) => f.name === name)) {
      throw new UserError('这里已经有名为「{name}」的文件夹', { name });
    }
    next.name = name;
  }
  if (patch.description !== undefined) next.description = patch.description?.trim() || null;
  if (patch.sort !== undefined) next.sort = patch.sort;
  if (patch.readme_file_id !== undefined) {
    if (patch.readme_file_id) {
      const ok = await db().prepare('SELECT 1 FROM files WHERE id = ? AND folder_id = ?').bind(patch.readme_file_id, id).first();
      if (!ok) throw new UserError('说明文件要从这个文件夹里的文件中选');
    }
    next.readme_file_id = patch.readme_file_id || null;
  }
  const cs = new ChangeSet(db(), actor, summary('修改文件夹 {path}', { path: places.path(`fd:${id}`, t) }));
  cs.updateKnown('folder', { id }, folder as unknown as Record<string, unknown>, next);
  return cs.commit();
}

export async function deleteFolder(actor: string, id: string, t: T): Promise<string | null> {
  const places = await Places.load();
  const folder = places.folders.get(id);
  if (!folder) throw new UserError('找不到这个文件夹');
  if (places.childFolders(`fd:${id}`).length) throw new UserError('文件夹里还有子文件夹，先移走或删除它们');
  const used = await db().prepare('SELECT count(*) AS n FROM files WHERE folder_id = ?').bind(id).first<{ n: number }>();
  if (used?.n) throw new UserError('文件夹里还有 {n} 个文件，先移走它们', { n: used.n });
  const parent = places.parentOf(`fd:${id}`);
  const cs = new ChangeSet(db(), actor, summary('删除文件夹 {path}', { path: places.path(`fd:${id}`, t) }));
  await cs.delete('folder', { id });
  await cs.commit();
  return parent;
}

/** Move a folder (with everything in it) under another place. */
export async function moveFolder(actor: string, id: string, under: string, t: T): Promise<number> {
  const places = await Places.load();
  const folder = places.folders.get(id);
  if (!folder) throw new UserError('找不到这个文件夹');
  if (!places.exists(under) || under === UNPLACED) throw new UserError('找不到这个位置');
  const subtree = places.subtree(id);
  if (under.startsWith('fd:') && subtree.includes(under.slice(3))) throw new UserError('不能把文件夹移到它自己里面');
  if (places.childFolders(under).some((f) => f.name === folder.name && f.id !== id)) {
    throw new UserError('这里已经有名为「{name}」的文件夹', { name: folder.name });
  }
  const anchor = places.anchorOf(under);
  const cs = new ChangeSet(db(), actor, summary('文件夹 {from} 移到 {to}', { from: places.path(`fd:${id}`, t), to: places.path(under, t) }));
  cs.updateKnown('folder', { id }, folder as unknown as Record<string, unknown>, anchor);
  const below = { era_id: anchor.era_id, release_id: anchor.release_id, edition_id: anchor.edition_id };
  for (const sub of subtree.slice(1)) {
    cs.updateKnown('folder', { id: sub }, places.folders.get(sub) as unknown as Record<string, unknown>, below);
  }
  const edition = anchor.edition_id ? places.editions.get(anchor.edition_id) : undefined;
  const inside = ['folder_id IN (SELECT value FROM json_each(?))', [JSON.stringify(subtree)]] as const;
  if (anchor.release_id !== folder.release_id) cs.updateFilesWhere(inside[0], [...inside[1]], { track_id: null });
  cs.updateFilesWhere(inside[0], [...inside[1]], { release_id: anchor.release_id, edition_id: anchor.edition_id, slot: edition?.slot ?? null });
  return cs.commit();
}

// ------------------------------------------------------------------------------------------ moving files

interface MoveRow {
  id: string;
  dir: string;
  state: string;
  rights: string;
  release_id: string | null;
  track_id: string | null;
  sealed_in: string | null;
}

async function loadRows<T>(columns: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const { results } = await db()
      .prepare(`SELECT ${columns} FROM files WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids.slice(i, i + 2000)))
      .all<T>();
    out.push(...results);
  }
  return out;
}

/** The patch that puts a file at a place (rights become the circle's own inside a release, if unknown). */
export function placePatch(row: Pick<MoveRow, 'state' | 'rights' | 'release_id' | 'track_id'>, place: Place): Record<string, unknown> {
  return {
    release_id: place.release_id,
    edition_id: place.edition_id,
    folder_id: place.folder_id,
    slot: place.slot,
    state: row.state === 'published' ? 'published' : 'classified',
    rights: row.rights === 'unknown' && place.release_id ? 'own' : row.rights,
    track_id: row.release_id === place.release_id ? row.track_id : null,
    dup_of: null,
  };
}

/** Give each file its patch (set-based, however many files). */
export function applyPatches(cs: ChangeSet, patches: Map<string, Record<string, unknown>>): number {
  cs.patchFiles(patches);
  return patches.size;
}

/** Editions filled by files for the first time are no longer missing. */
export function markEditionsCollected(cs: ChangeSet, places: Places, editionIds: Iterable<string | null>) {
  for (const id of new Set(editionIds)) {
    const e = id ? places.editions.get(id) : undefined;
    if (e && (e.status === 'missing' || e.status === 'unknown')) {
      cs.updateKnown('edition', { id: e.id }, { status: e.status }, { status: 'collected' });
      e.status = 'collected';
    }
  }
}

export interface MoveResult {
  summary: string;
  changed: number;
  skipped: number;
  batchId: string;
}

/**
 * Put files at a place. With `keep`, the folders below that original folder come along: a file in
 * `<keep>/a/b` goes to the folder a/b under the place (made where missing).
 */
export async function moveFiles(actor: string, ids: string[], where: string, t: T, keep?: string | null, newFolder?: string | null): Promise<MoveResult> {
  const places = await Places.load();
  if (!places.exists(where) || where === UNPLACED) throw new UserError('找不到这个位置');
  const rows = await loadRows<MoveRow>('id, dir, state, rights, release_id, track_id, sealed_in', ids);
  const cs = new ChangeSet(db(), actor, '');
  // A folder made in the 「移动到…」 dialog belongs to the same batch, so one undo removes both.
  const target = newFolder ? `fd:${ensureFolder(cs, places, where, [newFolder])}` : where;
  cs.setSummary(summary('整理台：{n} 个文件移到 {place}', { n: ids.length, place: places.path(target, t) }));
  const patches = new Map<string, Record<string, unknown>>();
  let skipped = 0;
  const base = keep?.replace(/\/+$/, '') ?? null;
  for (const row of rows) {
    if (row.sealed_in) {
      skipped += 1;
      continue;
    }
    let key = target;
    if (base !== null) {
      const rel = row.dir === base ? '' : base === '' ? row.dir : row.dir.startsWith(`${base}/`) ? row.dir.slice(base.length + 1) : '';
      const names = rel.split('/').filter(Boolean);
      if (names.length) key = `fd:${ensureFolder(cs, places, target, names)}`;
    }
    const place = key === target ? places.place(target) : places.place(key);
    patches.set(row.id, placePatch(row, place));
  }
  if (patches.size === 0 && skipped) throw new UserError('这些文件都在整体收藏的压缩包里，不能单独移动');
  applyPatches(cs, patches);
  const placed = [...patches.values()];
  await markCollected(cs, placed.map((p) => [p.release_id as string | null, p.slot as string | null] as const));
  markEditionsCollected(cs, places, placed.map((p) => p.edition_id as string | null));
  const changed = await cs.commit();
  return { summary: cs.summary, changed, skipped, batchId: cs.batchId };
}

// ------------------------------------------------------------------------------------------ kept whole

/** SQL (on `files`): every file inside the archive with id ?, at any depth. */
export const INSIDE_ARCHIVE = `files.id IN (WITH RECURSIVE m(id) AS (
    SELECT id FROM files WHERE member_of = ? UNION ALL SELECT f.id FROM files f JOIN m ON f.member_of = m.id
  ) SELECT id FROM m)`;

export interface SealResult {
  summary: string;
  changed: number;
  archives: number;
  hidden: number; // files now hidden (or shown again)
  refused: string[]; // names of archives with filed members
  skipped: number; // selected files that are not archives
  batchId: string;
}

/**
 * Keep archives whole (整体收藏), or open them up again. Their members leave the 整理台 and the
 * processing queue; the archive itself stays and is filed like any file. An archive whose members were
 * already filed somewhere is left alone (file them back first).
 */
export async function sealArchives(actor: string, ids: string[], seal: boolean, cs?: ChangeSet): Promise<SealResult> {
  const database = db();
  const rows = await loadRows<{ id: string; name: string; kind: string; format: string | null; sealed: number; sealed_in: string | null }>(
    'id, name, kind, format, sealed, sealed_in', ids,
  );
  const isArchive = (r: { kind: string; format: string | null }) =>
    r.kind === 'archive' || r.kind === 'disc_image' || (r.format ?? '').includes('"archive"');
  const archives = rows.filter((r) => isArchive(r) && !r.sealed_in && !!r.sealed !== seal);
  const skipped = rows.filter((r) => !isArchive(r)).length;
  const refused: string[] = [];
  const counts = await Promise.all(
    archives.map((a) =>
      database
        .prepare(
          seal
            ? `SELECT count(*) AS n, sum(${PLACED}) AS placed FROM files WHERE ${INSIDE_ARCHIVE} AND sealed_in IS NULL`
            : 'SELECT count(*) AS n, 0 AS placed FROM files WHERE sealed_in = ?',
        )
        .bind(a.id)
        .first<{ n: number; placed: number | null }>(),
    ),
  );
  const own = !cs;
  cs ??= new ChangeSet(database, actor, seal
    ? summary('整理台：{n} 个压缩包整体收藏', { n: archives.length })
    : summary('整理台：展开 {n} 个整体收藏的压缩包', { n: archives.length }));
  let hidden = 0;
  const done: string[] = [];
  archives.forEach((a, i) => {
    if (seal && counts[i]?.placed) {
      refused.push(a.name);
      return;
    }
    done.push(a.id);
    hidden += counts[i]?.n ?? 0;
    if (seal) cs!.updateFilesWhere(`${INSIDE_ARCHIVE} AND sealed_in IS NULL`, [a.id], { sealed_in: a.id });
    else cs!.updateFilesWhere('sealed_in = ?', [a.id], { sealed_in: null });
  });
  cs.updateFiles(done, { sealed: seal ? 1 : 0 });
  const changed = own ? await cs.commit() : 0;
  return { summary: cs.summary, changed, archives: done.length, hidden, refused, skipped, batchId: cs.batchId };
}

export const SEAL_NOTE = N_('整体收藏：包内文件不单独整理，只在文件页列出清单');
