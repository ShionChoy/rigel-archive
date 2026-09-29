// Where files sit in the archive (归档位置): one tree of folders. Every era (名义), release (作品) and
// edition (版本) is a folder of that type; the admins' own folders are «plain». A file sits in exactly one
// folder (files.folder_id) and carries the release and edition that folder belongs to (release_id,
// edition_id, slot), which the rest of the site reads. A plain folder belongs to the nearest release and
// edition above it; nothing about that is stored on the folder, so moving a folder is one row.
//
// Places are addressed by keys: fd:<folder id>; era:<id>, rel:<id>, ed:<id> name the folder of that
// entity (links and rule suggestions use them). «top» is the root of the tree, «unplaced» the files
// without a place (未归档). The original path of a file (dir) never changes.

import { ChangeSet } from './changes';
import { db, type EditionRow, type FolderRow } from './db';
import { N_, summary, UserError, type T } from './i18n';
import { newId } from './ids';
import { TypeList, type EditionType } from './types';

export const FOLDER_TYPES = ['plain', 'era', 'release', 'edition'] as const;
export type FolderType = (typeof FOLDER_TYPES)[number];
export const FOLDER_TYPE_LABELS: Record<FolderType, string> = {
  plain: N_('普通文件夹'),
  era: N_('名义'),
  release: N_('作品'),
  edition: N_('版本'),
};

export const FOLDER_COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink'] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];
export const FOLDER_COLOR_LABELS: Record<FolderColor, string> = {
  red: N_('红'), orange: N_('橙'), yellow: N_('黄'), green: N_('绿'), aqua: N_('青'), blue: N_('蓝'), purple: N_('紫'), pink: N_('粉'),
};

export interface EraInfo { id: string; name: string; sort: number }
export interface ReleaseInfo {
  id: string;
  era_id: string;
  catalog_no: string | null;
  title: string;
  release_date: string | null;
  kind: string;
  state: string;
}
export type EditionInfo = Pick<EditionRow, 'id' | 'release_id' | 'slot' | 'name' | 'catalog_no' | 'release_date' | 'status' | 'sort' | 'is_default'>;
export type FolderInfo = Pick<FolderRow, 'id' | 'parent_id' | 'type' | 'era_id' | 'release_id' | 'edition_id' | 'name' | 'description' | 'readme_file_id' | 'color' | 'sort'>;

/** The era, release and edition a folder belongs to (its own entity included). */
export interface Context {
  era_id: string | null;
  release_id: string | null;
  edition_id: string | null;
}

/** What filing a file somewhere writes into it. */
export interface Place {
  release_id: string | null;
  edition_id: string | null;
  folder_id: string | null;
  slot: string | null;
}

export const TOP = 'top';
export const UNPLACED = 'unplaced';

/** SQL (on `files`): shown in the 整理台 at all, i.e. not inside an archive kept whole. */
export const VISIBLE = 'files.sealed_in IS NULL';
/** SQL (on `files`): has a place in the archive. */
export const PLACED = '(files.folder_id IS NOT NULL OR files.release_id IS NOT NULL)';
/** SQL (on `files`): still to be organized: no place, not ignored, not hidden in a kept-whole archive. */
export const UNPLACED_SQL = `(${VISIBLE} AND files.release_id IS NULL AND files.folder_id IS NULL AND files.state != 'ignored')`;
/** SQL (on `files`): an archive or disc image, which can be kept whole. */
export const IS_ARCHIVE = "(files.kind IN ('archive', 'disc_image') OR json_extract(files.format, '$.archive') IS NOT NULL)";

const MAX_DEPTH = 64;
const collator = new Intl.Collator('ja', { numeric: true });

export function split(key: string): [string, string] {
  const at = key.indexOf(':');
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}

export const folderKey = (id: string) => `fd:${id}`;

/** Every era, release, edition and folder, loaded once per request. */
export class Places {
  readonly eras = new Map<string, EraInfo>();
  readonly releases = new Map<string, ReleaseInfo>();
  readonly editions = new Map<string, EditionInfo>();
  readonly folders = new Map<string, FolderInfo>();
  types = new TypeList([]);
  private readonly kids = new Map<string | null, string[]>();
  private readonly byEra = new Map<string, string>();
  private readonly byRelease = new Map<string, string>();
  private readonly byEdition = new Map<string, string>();

  static async load(database: D1Database = db()): Promise<Places> {
    const [eras, releases, editions, folders, types] = await database.batch([
      database.prepare('SELECT id, name, sort FROM eras ORDER BY sort'),
      database.prepare('SELECT id, era_id, catalog_no, title, release_date, kind, state FROM releases'),
      database.prepare('SELECT id, release_id, slot, name, catalog_no, release_date, status, sort, is_default FROM editions'),
      database.prepare('SELECT id, parent_id, type, era_id, release_id, edition_id, name, description, readme_file_id, color, sort FROM folders'),
      database.prepare('SELECT id, name_zh, name_ja, name_en, sort, missing_board FROM slot_types'),
    ]);
    const p = new Places();
    p.types = new TypeList(types.results as EditionType[]);
    for (const r of eras.results as EraInfo[]) p.eras.set(r.id, r);
    for (const r of releases.results as ReleaseInfo[]) p.releases.set(r.id, r);
    for (const r of editions.results as EditionInfo[]) p.editions.set(r.id, r);
    for (const r of folders.results as FolderInfo[]) p.addFolder(r);
    return p;
  }

  // ------------------------------------------------------------------ keeping the index

  /** Add a folder made (or changed) in this request, so later lookups see it. */
  addFolder(f: FolderInfo) {
    const old = this.folders.get(f.id);
    if (old) this.unindex(old);
    this.folders.set(f.id, f);
    const list = this.kids.get(f.parent_id) ?? [];
    list.push(f.id);
    this.kids.set(f.parent_id, list);
    if (f.era_id) this.byEra.set(f.era_id, f.id);
    if (f.release_id) this.byRelease.set(f.release_id, f.id);
    if (f.edition_id) this.byEdition.set(f.edition_id, f.id);
  }

  /** Change a folder in memory (parent, type, entity) for later steps of the same operation. */
  updateFolder(id: string, patch: Partial<FolderInfo>) {
    const f = this.folders.get(id);
    if (f) this.addFolder({ ...f, ...patch });
  }

  removeFolder(id: string) {
    const f = this.folders.get(id);
    if (!f) return;
    this.unindex(f);
    this.folders.delete(id);
  }

  private unindex(f: FolderInfo) {
    const list = this.kids.get(f.parent_id);
    if (list) this.kids.set(f.parent_id, list.filter((k) => k !== f.id));
    if (f.era_id && this.byEra.get(f.era_id) === f.id) this.byEra.delete(f.era_id);
    if (f.release_id && this.byRelease.get(f.release_id) === f.id) this.byRelease.delete(f.release_id);
    if (f.edition_id && this.byEdition.get(f.edition_id) === f.id) this.byEdition.delete(f.edition_id);
  }

  addEdition(e: EditionInfo) {
    this.editions.set(e.id, e);
  }

  addRelease(r: ReleaseInfo) {
    this.releases.set(r.id, r);
  }

  addEra(e: EraInfo) {
    this.eras.set(e.id, e);
  }

  // ------------------------------------------------------------------ finding folders

  eraFolder(id: string): FolderInfo | undefined {
    return this.folders.get(this.byEra.get(id) ?? '');
  }

  releaseFolder(id: string): FolderInfo | undefined {
    return this.folders.get(this.byRelease.get(id) ?? '');
  }

  editionFolder(id: string): FolderInfo | undefined {
    return this.folders.get(this.byEdition.get(id) ?? '');
  }

  /** The folder a key names (fd:, or era: / rel: / ed: for the entity's folder). */
  folderOf(key: string): FolderInfo | undefined {
    const [kind, id] = split(key);
    if (kind === 'fd') return this.folders.get(id);
    if (kind === 'era') return this.eraFolder(id);
    if (kind === 'rel') return this.releaseFolder(id);
    if (kind === 'ed') return this.editionFolder(id);
    return undefined;
  }

  /** The canonical key (fd:…) of a key, or TOP / UNPLACED, or null when it names nothing. */
  canonical(key: string): string | null {
    if (key === TOP || key === UNPLACED) return key;
    const f = this.folderOf(key);
    return f ? folderKey(f.id) : null;
  }

  exists(key: string): boolean {
    return this.canonical(key) !== null;
  }

  /** The key of a file's place, or null when it has none. */
  keyOf(f: { release_id: string | null; edition_id?: string | null; folder_id?: string | null }): string | null {
    if (f.folder_id && this.folders.has(f.folder_id)) return folderKey(f.folder_id);
    const typed = (f.edition_id && this.editionFolder(f.edition_id)) || (f.release_id && this.releaseFolder(f.release_id));
    return typed ? folderKey(typed.id) : null;
  }

  // ------------------------------------------------------------------ the tree

  /** Siblings in tree order: a manual order when set, else eras, releases by date, editions by slot, then folders by name. */
  compare = (a: FolderInfo, b: FolderInfo): number => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    const rank = (f: FolderInfo) => (f.type === 'plain' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.era_id && b.era_id) return (this.eras.get(a.era_id)?.sort ?? 0) - (this.eras.get(b.era_id)?.sort ?? 0);
    if (a.release_id && b.release_id) {
      const x = this.releases.get(a.release_id);
      const y = this.releases.get(b.release_id);
      if (x && y) {
        return (x.release_date ?? '9999').localeCompare(y.release_date ?? '9999')
          || collator.compare(x.catalog_no ?? '', y.catalog_no ?? '') || collator.compare(x.title, y.title);
      }
    }
    if (a.edition_id && b.edition_id) {
      const x = this.editions.get(a.edition_id);
      const y = this.editions.get(b.edition_id);
      if (x && y) {
        return this.types.index(x.slot) - this.types.index(y.slot) || x.sort - y.sort
          || (x.release_date ?? '9999').localeCompare(y.release_date ?? '9999') || collator.compare(x.name, y.name);
      }
    }
    return collator.compare(a.name, b.name);
  };

  /** The folders directly under a folder (null = the top), in tree order. */
  children(parentId: string | null): FolderInfo[] {
    return (this.kids.get(parentId) ?? []).map((id) => this.folders.get(id)!).filter(Boolean).sort(this.compare);
  }

  /** The folders directly under a place key (TOP for the top level). */
  childFolders(key: string): FolderInfo[] {
    if (key === TOP) return this.children(null);
    const f = this.folderOf(key);
    return f ? this.children(f.id) : [];
  }

  /** The folder and every folder below it, parents before children. */
  subtree(folderId: string): string[] {
    const out = [folderId];
    for (let i = 0; i < out.length; i += 1) out.push(...(this.kids.get(out[i]) ?? []));
    return out;
  }

  /** The folder and its ancestors, nearest first. */
  ancestors(folderId: string | null): FolderInfo[] {
    const out: FolderInfo[] = [];
    for (let f = folderId ? this.folders.get(folderId) : undefined; f && out.length < MAX_DEPTH; f = f.parent_id ? this.folders.get(f.parent_id) : undefined) {
      out.push(f);
    }
    return out;
  }

  /** The era, release and edition a folder belongs to: its own entity or the nearest one above it. */
  context(folderId: string | null): Context {
    const ctx: Context = { era_id: null, release_id: null, edition_id: null };
    for (const f of this.ancestors(folderId)) {
      if (f.edition_id && !ctx.edition_id && !ctx.release_id) ctx.edition_id = f.edition_id;
      if (f.release_id && !ctx.release_id) ctx.release_id = f.release_id;
      if (f.era_id) {
        ctx.era_id = f.era_id;
        break;
      }
    }
    // An edition's release is its parent release folder; keep them consistent if a folder was edited by hand.
    if (ctx.edition_id && !ctx.release_id) ctx.release_id = this.editions.get(ctx.edition_id)?.release_id ?? null;
    return ctx;
  }

  /** Any folder below this one (not itself) of these types. */
  hasBelow(folderId: string, types: readonly FolderType[]): boolean {
    return this.subtree(folderId).slice(1).some((id) => types.includes(this.folders.get(id)!.type));
  }

  /** The keys from the top down to this place. */
  chain(key: string): string[] {
    const f = this.folderOf(key);
    return f ? this.ancestors(f.id).reverse().map((a) => folderKey(a.id)) : [];
  }

  /** The key of the place a folder hangs under (TOP for the top level). */
  parentOf(key: string): string | null {
    const f = this.folderOf(key);
    if (!f) return null;
    return f.parent_id ? folderKey(f.parent_id) : TOP;
  }

  // ------------------------------------------------------------------ names

  releaseLabel(id: string): string {
    const r = this.releases.get(id);
    if (!r) return id;
    return r.catalog_no ? `${r.catalog_no} ${r.title}` : r.title;
  }

  editionLabel(e: Pick<EditionInfo, 'slot' | 'name'>, t: T): string {
    return this.types.editionLabel(e, t);
  }

  folderName(f: FolderInfo, t: T): string {
    if (f.era_id) return this.eras.get(f.era_id)?.name ?? f.era_id;
    if (f.release_id) return this.releaseLabel(f.release_id);
    if (f.edition_id) {
      const e = this.editions.get(f.edition_id);
      return e ? this.editionLabel(e, t) : f.edition_id;
    }
    return f.name;
  }

  /** The name of one node. */
  name(key: string, t: T): string {
    if (key === TOP) return t('全部文件夹');
    if (key === UNPLACED) return t('未归档');
    const f = this.folderOf(key);
    return f ? this.folderName(f, t) : key;
  }

  /** «Rigël Theatre / RTCD-004 Lengsel / CD 抓轨 · 再版» */
  path(key: string, t: T): string {
    return this.chain(key).map((k) => this.name(k, t)).join(' / ');
  }

  /** What filing a file in this folder writes. */
  place(key: string): Place {
    if (key === TOP || key === UNPLACED) throw new UserError('文件要放进某个文件夹');
    const f = this.folderOf(key);
    if (!f) throw new UserError('找不到这个位置');
    const ctx = this.context(f.id);
    const edition = ctx.edition_id ? this.editions.get(ctx.edition_id) : undefined;
    return { release_id: ctx.release_id, edition_id: ctx.edition_id, folder_id: f.id, slot: edition?.slot ?? null };
  }

  /** Every folder in tree order, for the 「移动到…」 picker and the page's scripts. */
  options(t: T): { key: string; id: string; parent: string | null; path: string; name: string; kind: FolderType; depth: number }[] {
    const out: { key: string; id: string; parent: string | null; path: string; name: string; kind: FolderType; depth: number }[] = [];
    const walk = (f: FolderInfo, depth: number, prefix: string) => {
      const name = this.folderName(f, t);
      const path = prefix ? `${prefix} / ${name}` : name;
      out.push({ key: folderKey(f.id), id: f.id, parent: f.parent_id, path, name, kind: f.type, depth });
      if (depth < MAX_DEPTH) for (const c of this.children(f.id)) walk(c, depth + 1, path);
    };
    for (const f of this.children(null)) walk(f, 0, '');
    return out;
  }
}

/** SQL condition (on `files`) for the files at a place: in the folder, or (withSub) in it and below it. */
export function locationWhere(places: Places, key: string, withSub = true): { sql: string; binds: unknown[] } {
  if (key === UNPLACED) return { sql: UNPLACED_SQL, binds: [] };
  if (key === TOP) return { sql: 'files.folder_id IS NOT NULL', binds: [] };
  const f = places.folderOf(key);
  if (!f) return { sql: '0', binds: [] };
  if (!withSub) return { sql: 'files.folder_id = ?', binds: [f.id] };
  return { sql: 'files.folder_id IN (SELECT value FROM json_each(?))', binds: [JSON.stringify(places.subtree(f.id))] };
}

// ------------------------------------------------------------------------------------------ tree

export interface LocNode {
  key: string;
  id: string;
  kind: FolderType;
  name: string;
  n: number; // files in this folder and below
  own: number; // files directly in it
  children: LocNode[];
  color: string | null;
  status?: string; // editions: collected / missing …
  readme?: boolean;
}

/** The folder tree with file counts (visible files). */
export async function folderTree(places: Places, t: T): Promise<LocNode[]> {
  const { results } = await db()
    .prepare(`SELECT folder_id, count(*) AS n FROM files WHERE ${VISIBLE} AND folder_id IS NOT NULL GROUP BY folder_id`)
    .all<{ folder_id: string; n: number }>();
  const direct = new Map(results.map((r) => [r.folder_id, r.n]));
  const build = (f: FolderInfo, depth: number): LocNode => {
    const children = depth < MAX_DEPTH ? places.children(f.id).map((c) => build(c, depth + 1)) : [];
    const own = direct.get(f.id) ?? 0;
    return {
      key: folderKey(f.id),
      id: f.id,
      kind: f.type,
      name: places.folderName(f, t),
      own,
      n: own + children.reduce((s, c) => s + c.n, 0),
      children,
      color: f.color,
      status: f.edition_id ? places.editions.get(f.edition_id)?.status : undefined,
      readme: !!f.readme_file_id,
    };
  };
  return places.children(null).map((f) => build(f, 0));
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

/** The sort value for a new folder under a parent: last when the siblings are in a manual order. */
export function nextSort(places: Places, parentId: string | null): number {
  const max = Math.max(0, ...places.children(parentId).map((f) => f.sort));
  return max > 0 ? max + 10 : 0;
}

/** The parent id of a folder made directly under this place (null at the top). */
export function parentIdOf(places: Places, key: string): string | null {
  if (key === TOP) return null;
  const f = places.folderOf(key);
  if (!f) throw new UserError('找不到这个位置');
  return f.id;
}

export function plainFolder(id: string, parentId: string | null, name: string, sort: number): FolderInfo {
  return { id, parent_id: parentId, type: 'plain', era_id: null, release_id: null, edition_id: null, name, description: null, readme_file_id: null, color: null, sort };
}

/**
 * The folder at `names` below `under` (e.g. ['游戏与模拟器'] under era:dezaemon), made in `cs` where
 * missing. Returns its id.
 */
export function ensureFolder(cs: ChangeSet, places: Places, under: string, names: string[]): string {
  let parentId = under === TOP ? null : ensureEntityFolder(cs, places, under);
  let id = '';
  for (const raw of names) {
    const name = checkFolderName(raw);
    const found = places.children(parentId).find((f) => f.type === 'plain' && f.name === name);
    if (found) id = found.id;
    else {
      id = newId('fd');
      const row = plainFolder(id, parentId, name, nextSort(places, parentId));
      cs.queueCreate('folder', { ...row });
      places.addFolder(row);
    }
    parentId = id;
  }
  return id;
}

/**
 * The folder id of a place key; the folder of an era, release or edition is made in `cs` when it has
 * none yet (a release added by the import after the tree was built).
 */
export function ensureEntityFolder(cs: ChangeSet, places: Places, key: string, direct = false): string {
  const found = places.folderOf(key);
  if (found) return found.id;
  const [kind, id] = split(key);
  const make = (parentId: string | null, entity: Pick<FolderInfo, 'era_id' | 'release_id' | 'edition_id'>, type: FolderType): string => {
    const row: FolderInfo = { id: newId('fd'), parent_id: parentId, type, name: '', description: null, readme_file_id: null, color: null, sort: 0, ...entity };
    // Queued rows are inserted before everything else in the batch; `direct` keeps the order of the calls,
    // for an entity made with cs.create just before.
    if (direct) cs.create('folder', { ...row });
    else cs.queueCreate('folder', { ...row });
    places.addFolder(row);
    return row.id;
  };
  if (kind === 'era' && places.eras.has(id)) return make(null, { era_id: id, release_id: null, edition_id: null }, 'era');
  if (kind === 'rel') {
    const r = places.releases.get(id);
    if (r) return make(ensureEntityFolder(cs, places, `era:${r.era_id}`, direct), { era_id: null, release_id: id, edition_id: null }, 'release');
  }
  if (kind === 'ed') {
    const e = places.editions.get(id);
    if (e) return make(ensureEntityFolder(cs, places, `rel:${e.release_id}`, direct), { era_id: null, release_id: null, edition_id: id }, 'edition');
  }
  throw new UserError('找不到这个位置');
}

/**
 * A name for a new file in this folder that no file there shows yet (ignoring case, as renames check):
 * `name` itself, else «cover (2).jpg», «cover (3).jpg» …
 */
export async function freeFileName(folderId: string | null, name: string): Promise<string> {
  if (!folderId) return name;
  const { results } = await db()
    .prepare('SELECT coalesce(download_name, name) AS shown FROM files WHERE folder_id = ? AND sealed_in IS NULL')
    .bind(folderId)
    .all<{ shown: string }>();
  const taken = new Set(results.map((r) => r.shown.toLowerCase()));
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let free = name;
  for (let n = 2; taken.has(free.toLowerCase()); n += 1) free = `${stem} (${n})${ext}`;
  return free;
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

export async function loadRows<R>(columns: string, ids: string[]): Promise<R[]> {
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
 * Put files in a folder. With `keep`, the folders below that original folder come along: a file in
 * `<keep>/a/b` goes to the folder a/b under the place (made where missing).
 */
export async function moveFiles(actor: string, ids: string[], where: string, t: T, keep?: string | null, newFolder?: string | null): Promise<MoveResult> {
  const places = await Places.load();
  if (!places.exists(where) || where === UNPLACED || (where === TOP && !newFolder)) throw new UserError('文件要放进某个文件夹');
  const rows = await loadRows<MoveRow>('id, dir, state, rights, release_id, track_id, sealed_in', ids);
  const cs = new ChangeSet(db(), actor, '');
  // A folder made in the 「移动到…」 dialog belongs to the same batch, so one undo removes both.
  const target = newFolder ? folderKey(ensureFolder(cs, places, where, [newFolder])) : folderKey(ensureEntityFolder(cs, places, where));
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
      if (names.length) key = folderKey(ensureFolder(cs, places, target, names));
    }
    patches.set(row.id, placePatch(row, places.place(key)));
  }
  if (patches.size === 0 && skipped) throw new UserError('这些文件都在整体收藏的压缩包里，不能单独移动');
  applyPatches(cs, patches);
  const placed = [...patches.values()];
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
