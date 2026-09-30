// Folder operations of the 整理台 (新建、重命名、移动、合并、排序、删除、设类型、颜色) and the personal
// 快速访问 list. Every change goes through one ChangeSet, so each operation is one entry in the history
// and can be undone as a whole. The tree itself is described in locations.ts.

import { ChangeSet } from './changes';
import { isOneOf } from './constants';
import { db } from './db';
import { chosenForm, kindOf, loadForms } from './forms';
import { summary, UserError, type Params, type T } from './i18n';
import { newId } from './ids';
import {
  FOLDER_COLORS, NO_PLACE, Places, TOP, UNPLACED, checkFolderName, ensureFolder, folderKey, markEditionsCollected,
  nextSort, type Context, type FolderInfo, type FolderType,
} from './locations';
import { NEW_TYPE, addType } from './types';

/** A move would put two folders of the same name side by side: the admin chooses to merge or keep both. */
export class ConflictError extends UserError {
  constructor(readonly names: string[]) {
    super('目标位置已有同名文件夹：{names}', { names: names.join('、') });
  }
}

/** An operation that removes more than it looks like (a release's track list): asked once more. */
export class ConfirmError extends UserError {
  constructor(text: string, params?: Params) {
    super(text, params);
  }
}

export type ConflictMode = 'ask' | 'merge' | 'both';

export interface FolderResult {
  summary: string;
  changed: number;
  batchId: string | null;
  id?: string; // the folder made or changed
  parent?: string | null; // where to go after a deletion
}

const done = async (cs: ChangeSet, extra: Partial<FolderResult> = {}): Promise<FolderResult> => {
  const changed = await cs.commit();
  return { summary: cs.summary, changed, batchId: changed ? cs.batchId : null, ...extra };
};

const row = (f: FolderInfo) => f as unknown as Record<string, unknown>;

function mustFolder(places: Places, id: string): FolderInfo {
  const f = places.folders.get(id);
  if (!f) throw new UserError('找不到这个文件夹');
  return f;
}

/** The top-level ones of the chosen folders: a folder inside another chosen one goes along with it. */
function roots(places: Places, ids: string[]): string[] {
  const chosen = new Set(ids.filter((id) => places.folders.has(id)));
  return [...chosen].filter((id) => !places.ancestors(places.folders.get(id)!.parent_id).some((a) => chosen.has(a.id)));
}

/** A name not used by a plain folder under this parent: «扫描», else «扫描 (2)», «扫描 (3)» … */
function freeName(places: Places, parentId: string | null, name: string, except?: string): string {
  const taken = new Set(places.children(parentId).filter((f) => f.type === 'plain' && f.id !== except).map((f) => f.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i += 1) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}

const sameName = (places: Places, parentId: string | null, name: string, except?: string) =>
  places.children(parentId).find((f) => f.type === 'plain' && f.name === name && f.id !== except);

// ------------------------------------------------------------------------------------------ where folders may go

/** Why this folder cannot go under that parent (null = it can). */
export function placeProblem(places: Places, id: string, parentId: string | null): UserError | null {
  const f = mustFolder(places, id);
  if (parentId && places.subtree(id).includes(parentId)) return new UserError('不能把文件夹移到它自己里面');
  const ctx = places.context(parentId);
  const parent = parentId ? places.folders.get(parentId) : undefined;
  if (f.type === 'era') return parentId ? new UserError('名义只能放在最顶层') : null;
  if (f.type === 'edition') {
    if (parent?.type !== 'release') return new UserError('版本只能放在作品的下一层');
    const e = places.editions.get(f.edition_id!);
    const clash = e && [...places.editions.values()].some((x) => x.id !== e.id && x.release_id === parent.release_id && x.slot === e.slot && x.name === e.name);
    return clash ? new UserError('目标作品已经有同类型、同名的版本') : null;
  }
  if (f.type === 'release' || places.hasBelow(id, ['release'])) {
    if (!ctx.era_id) return new UserError('作品要放在某个名义里（中间可以隔着普通文件夹）');
    if (ctx.release_id) return new UserError('作品不能放进另一个作品或版本里');
  }
  return null;
}

// ------------------------------------------------------------------------------------------ files follow their folder

/** Folders whose files take their release and edition from above this folder (it, and plain folders below down to the next typed one). */
function freeFolders(places: Places, id: string): string[] {
  const out: string[] = [];
  const walk = (fid: string) => {
    const f = places.folders.get(fid)!;
    if (f.type !== 'plain') return;
    out.push(fid);
    for (const c of places.children(fid)) walk(c.id);
  };
  walk(id);
  return out;
}

/** The file fields a context writes (the slot comes from the edition). */
function contextPatch(places: Places, ctx: Context, releaseChanged: boolean): Record<string, unknown> {
  const edition = ctx.edition_id ? places.editions.get(ctx.edition_id) : undefined;
  return {
    release_id: ctx.release_id,
    edition_id: ctx.edition_id,
    slot: edition?.slot ?? null,
    ...(releaseChanged ? { track_id: null } : {}),
  };
}

/** Files in these folders take a new context (a folder moved, merged or given a type). */
function refile(cs: ChangeSet, places: Places, folderIds: string[], before: Context, after: Context) {
  if (folderIds.length === 0) return;
  if (before.release_id === after.release_id && before.edition_id === after.edition_id) return;
  const where = 'folder_id IN (SELECT value FROM json_each(?))';
  const list = JSON.stringify(folderIds);
  // Inside a release, files of unknown rights become the circle's own (as when files are moved there).
  if (after.release_id) cs.updateFilesWhere(`${where} AND rights = 'unknown'`, [list], { rights: 'own' });
  cs.updateFilesWhere(where, [list], contextPatch(places, after, before.release_id !== after.release_id));
}

/** Once files are in an edition, its 缺档 / 待确认 status becomes 已收录. */
async function markFilled(cs: ChangeSet, places: Places, folderIds: string[], ctx: Context) {
  if (!ctx.edition_id || folderIds.length === 0) return;
  const any = await db().prepare('SELECT 1 FROM files WHERE folder_id IN (SELECT value FROM json_each(?)) LIMIT 1').bind(JSON.stringify(folderIds)).first();
  if (!any) return;
  markEditionsCollected(cs, places, [ctx.edition_id]);
}

/**
 * Put a folder under another parent (in memory and in `cs`) and carry out what follows: the files that
 * took their release and edition from above it get the new ones, a release gets its new era, an edition
 * its new release (its track order, made of the old release's tracks, is removed).
 */
async function relocate(cs: ChangeSet, places: Places, id: string, parentId: string | null, name?: string) {
  const f = mustFolder(places, id);
  const before = places.context(f.parent_id);
  const releasesBelow = places.subtree(id).map((k) => places.folders.get(k)!).filter((x) => x.type === 'release');
  const patch: Partial<FolderInfo> = { parent_id: parentId, sort: nextSort(places, parentId) };
  if (name !== undefined && f.type === 'plain') patch.name = name;
  cs.updateKnown('folder', { id }, row(f), patch);
  places.updateFolder(id, patch);
  const after = places.context(parentId);

  if (before.era_id !== after.era_id && after.era_id) {
    for (const r of releasesBelow) {
      const release = places.releases.get(r.release_id!);
      if (release && release.era_id !== after.era_id) {
        cs.updateKnown('release', { id: release.id }, { era_id: release.era_id }, { era_id: after.era_id });
        release.era_id = after.era_id;
      }
    }
  }
  if (f.type === 'edition' && f.edition_id && before.release_id !== after.release_id && after.release_id) {
    const e = places.editions.get(f.edition_id)!;
    const current = await db().prepare('SELECT release_id, based_on, is_default FROM editions WHERE id = ?').bind(e.id).first<Record<string, unknown>>();
    cs.updateKnown('edition', { id: e.id }, current ?? { release_id: e.release_id }, { release_id: after.release_id, based_on: null, is_default: 0 });
    e.release_id = after.release_id;
    cs.deleteWhere('edition_track', 't.edition_id = ?1', [e.id]);
    cs.updateFilesWhere('edition_id = ?', [e.id], { release_id: after.release_id, track_id: null });
  }
  if (f.type === 'plain') {
    const free = freeFolders(places, id);
    refile(cs, places, free, before, after);
    await markFilled(cs, places, free, after);
  }
}

/** Move everything in `fromId` into `intoId` (same-named plain folders merge too), then remove `fromId`. */
async function mergeInto(cs: ChangeSet, places: Places, fromId: string, intoId: string) {
  const from = mustFolder(places, fromId);
  const into = mustFolder(places, intoId);
  for (const c of places.children(fromId)) {
    const same = c.type === 'plain' ? sameName(places, intoId, c.name) : undefined;
    if (same) await mergeInto(cs, places, c.id, same.id);
    else await relocate(cs, places, c.id, intoId);
  }
  const before = places.context(fromId);
  const after = places.context(intoId);
  if (after.release_id) cs.updateFilesWhere("folder_id = ? AND rights = 'unknown'", [fromId], { rights: 'own' });
  cs.updateFilesWhere('folder_id = ?', [fromId], {
    folder_id: intoId,
    ...(before.release_id !== after.release_id || before.edition_id !== after.edition_id ? contextPatch(places, after, before.release_id !== after.release_id) : {}),
  });
  if (from.readme_file_id && !into.readme_file_id) {
    cs.updateKnown('folder', { id: intoId }, row(into), { readme_file_id: from.readme_file_id });
    places.updateFolder(intoId, { readme_file_id: from.readme_file_id });
  }
  cs.deleteWhere('folder', 't.id = ?1', [fromId]);
  places.removeFolder(fromId);
}

// ------------------------------------------------------------------------------------------ operations

function parentOfKey(places: Places, key: string): string | null {
  const k = places.canonical(key);
  if (!k || k === UNPLACED) throw new UserError('找不到这个位置');
  return k === TOP ? null : places.folderOf(k)!.id;
}

export async function createFolder(actor: string, under: string, rawName: string, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const parentId = parentOfKey(places, under);
  const name = checkFolderName(rawName);
  if (sameName(places, parentId, name)) throw new UserError('这里已经有名为「{name}」的文件夹', { name });
  const cs = new ChangeSet(db(), actor, summary('新建文件夹 {path}', { path: [parentId ? places.path(folderKey(parentId), t) : '', name].filter(Boolean).join(' / ') }));
  const id = ensureFolder(cs, places, parentId ? folderKey(parentId) : TOP, [name]);
  return done(cs, { id });
}

/** 批量新建: one folder per line; «a/b» makes b inside a. Folders that exist already are left as they are. */
export async function createFolders(actor: string, under: string, text: string, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const parentId = parentOfKey(places, under);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new UserError('请每行写一个文件夹名');
  if (lines.length > 500) throw new UserError('一次最多新建 {n} 个', { n: 500 });
  const before = places.folders.size;
  const cs = new ChangeSet(db(), actor, '');
  for (const line of lines) ensureFolder(cs, places, parentId ? folderKey(parentId) : TOP, line.split('/').map((p) => p.trim()).filter(Boolean));
  const n = places.folders.size - before;
  cs.setSummary(summary('在 {path} 批量新建 {n} 个文件夹', { path: parentId ? places.path(folderKey(parentId), t) : t('顶层'), n }));
  return done(cs);
}

/** Rename: a plain folder's name, an era's name, a release's title, an edition's name. */
export async function renameFolder(actor: string, id: string, rawName: string, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const f = mustFolder(places, id);
  const name = rawName.normalize('NFC').trim();
  const cs = new ChangeSet(db(), actor, summary('重命名 {from} → {to}', { from: places.folderName(f, t), to: name }));
  if (f.type === 'plain') {
    const clean = checkFolderName(name);
    if (sameName(places, f.parent_id, clean, f.id)) throw new UserError('这里已经有名为「{name}」的文件夹', { name: clean });
    cs.updateKnown('folder', { id }, row(f), { name: clean });
  } else if (f.era_id) {
    if (!name || name.length > 100) throw new UserError('名称不能为空');
    const era = places.eras.get(f.era_id)!;
    if ([...places.eras.values()].some((e) => e.id !== era.id && e.name === name)) throw new UserError('已有同名的名义');
    cs.updateKnown('era', { id: era.id }, { name: era.name }, { name });
  } else if (f.release_id) {
    if (!name || name.length > 300) throw new UserError('标题不能为空');
    const r = places.releases.get(f.release_id)!;
    cs.updateKnown('release', { id: r.id }, { title: r.title }, { title: name });
  } else if (f.edition_id) {
    if (name.length > 100) throw new UserError('内容过长');
    const e = places.editions.get(f.edition_id)!;
    if ([...places.editions.values()].some((x) => x.id !== e.id && x.release_id === e.release_id && x.slot === e.slot && x.name === name)) {
      throw new UserError('这个作品已经有同类型、同名的版本');
    }
    cs.updateKnown('edition', { id: e.id }, { name: e.name }, { name });
  }
  return done(cs, { id });
}

/** 说明、说明文件、颜色. */
export async function updateFolderInfo(
  actor: string, id: string, patch: { description?: string | null; readme_file_id?: string | null; color?: string | null }, t: T,
): Promise<FolderResult> {
  const places = await Places.load();
  const f = mustFolder(places, id);
  const next: Record<string, unknown> = {};
  if (patch.description !== undefined) {
    const d = patch.description?.trim() || null;
    if (d && d.length > 4000) throw new UserError('内容过长');
    next.description = d;
  }
  if (patch.color !== undefined) {
    if (patch.color && !isOneOf(FOLDER_COLORS, patch.color)) throw new UserError('未知的颜色');
    next.color = patch.color || null;
  }
  if (patch.readme_file_id !== undefined) {
    if (patch.readme_file_id) {
      const ok = await db().prepare('SELECT 1 FROM files WHERE id = ? AND folder_id = ?').bind(patch.readme_file_id, id).first();
      if (!ok) throw new UserError('说明文件要从这个文件夹里的文件中选');
    }
    next.readme_file_id = patch.readme_file_id || null;
  }
  const cs = new ChangeSet(db(), actor, summary('修改文件夹 {path}', { path: places.path(folderKey(id), t) }));
  cs.updateKnown('folder', { id }, row(f), next);
  return done(cs, { id });
}

/** Move folders (several at once) under another place. Same-named folders there: ask, merge or keep both. */
export async function moveFolders(actor: string, ids: string[], under: string, mode: ConflictMode, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const parentId = parentOfKey(places, under);
  const list = roots(places, ids).filter((id) => places.folders.get(id)!.parent_id !== parentId);
  if (list.length === 0) return { summary: summary('没有改动'), changed: 0, batchId: null };
  for (const id of list) {
    const problem = placeProblem(places, id, parentId);
    if (problem) throw problem;
  }
  if (mode === 'ask') {
    const clash: string[] = [];
    const names = new Set(places.children(parentId).filter((f) => f.type === 'plain').map((f) => f.name));
    for (const id of list) {
      const f = places.folders.get(id)!;
      if (f.type !== 'plain') continue;
      if (names.has(f.name)) clash.push(f.name);
      names.add(f.name);
    }
    if (clash.length) throw new ConflictError([...new Set(clash)]);
  }
  const target = parentId ? places.path(folderKey(parentId), t) : t('顶层');
  const first = places.folderName(places.folders.get(list[0])!, t);
  const cs = new ChangeSet(db(), actor, list.length === 1
    ? summary('文件夹 {from} 移到 {to}', { from: first, to: target })
    : summary('{n} 个文件夹移到 {to}', { n: list.length, to: target }));
  for (const id of list) {
    const f = places.folders.get(id)!;
    const same = f.type === 'plain' ? sameName(places, parentId, f.name, id) : undefined;
    if (same && mode === 'merge') await mergeInto(cs, places, id, same.id);
    else await relocate(cs, places, id, parentId, same ? freeName(places, parentId, f.name, id) : undefined);
  }
  return done(cs);
}

/** 「合并到…」: everything in a plain folder moves into another folder (same-named folders merge too), then it is removed. */
export async function mergeFolder(actor: string, id: string, into: string, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const from = mustFolder(places, id);
  const target = places.folderOf(into);
  if (!target) throw new UserError('找不到这个位置');
  if (from.type !== 'plain') throw new UserError('只有普通文件夹可以合并到别的文件夹');
  if (target.id === id || places.subtree(id).includes(target.id)) throw new UserError('不能把文件夹合并到它自己里面');
  for (const c of places.children(id)) {
    const problem = placeProblem(places, c.id, target.id);
    if (problem) throw problem;
  }
  const cs = new ChangeSet(db(), actor, summary('文件夹 {from} 合并到 {to}', { from: places.path(folderKey(id), t), to: places.path(folderKey(target.id), t) }));
  await mergeInto(cs, places, id, target.id);
  return done(cs, { id: target.id });
}

/** A manual order for the folders under a place (ids in the new order), or null for the natural order. */
export async function reorderFolders(actor: string, under: string, order: string[] | null, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const parentId = parentOfKey(places, under);
  const children = places.children(parentId);
  const cs = new ChangeSet(db(), actor, order
    ? summary('调整 {path} 下的文件夹顺序', { path: parentId ? places.path(folderKey(parentId), t) : t('顶层') })
    : summary('{path} 下的文件夹恢复默认顺序', { path: parentId ? places.path(folderKey(parentId), t) : t('顶层') }));
  if (order) {
    const ids = new Set(children.map((c) => c.id));
    if (order.length !== ids.size || !order.every((id) => ids.has(id))) throw new UserError('文件夹已被别人修改，请刷新后重试');
    order.forEach((id, i) => cs.updateKnown('folder', { id }, row(places.folders.get(id)!), { sort: (i + 1) * 10 }));
  } else {
    for (const c of children) cs.updateKnown('folder', { id: c.id }, row(c), { sort: 0 });
  }
  return done(cs);
}

/** Files of a deleted folder go back to 未归档. */
const UNPLACE = { ...NO_PLACE, state: 'inbox' };

/** Delete folders: the files in them go back to 未归档 (never deleted); an era, release or edition goes with its folder. */
export async function deleteFolders(actor: string, ids: string[], confirmed: boolean, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const database = db();
  const list = roots(places, ids);
  if (list.length === 0) throw new UserError('找不到这个文件夹');
  for (const id of list) {
    const f = places.folders.get(id)!;
    const name = places.folderName(f, t);
    if (f.type === 'plain' && places.hasBelow(id, ['era', 'release', 'edition'])) throw new UserError('「{name}」里有作品，先移走或删除作品', { name });
    if (f.type === 'era' && places.hasBelow(id, ['release'])) throw new UserError('名义「{name}」里还有作品，不能删除', { name });
    if (f.release_id && places.releases.get(f.release_id)?.state === 'published') throw new UserError('作品「{name}」已发布，先改回草稿再删除', { name });
    const published = await database
      .prepare("SELECT count(*) AS n FROM files WHERE folder_id IN (SELECT value FROM json_each(?)) AND state = 'published'")
      .bind(JSON.stringify(places.subtree(id)))
      .first<{ n: number }>();
    if (published?.n) throw new UserError('「{name}」里有 {n} 个已发布的文件，先取消发布', { name, n: published.n });
  }
  // An era, release or edition goes with its folder (its data, its editions and track lists): always asked first.
  if (!confirmed) {
    const lines: string[] = [];
    for (const id of list) {
      const f = places.folders.get(id)!;
      if (f.type === 'plain') continue;
      const name = places.folderName(f, t);
      const sub = JSON.stringify(places.subtree(id));
      const editions = places.subtree(id).map((k) => places.folders.get(k)!.edition_id).filter((e): e is string => !!e);
      const [files, tracks, rows] = await database.batch([
        database.prepare('SELECT count(*) AS n FROM files WHERE folder_id IN (SELECT value FROM json_each(?)) AND sealed_in IS NULL').bind(sub),
        database.prepare('SELECT count(*) AS n FROM tracks WHERE release_id = ?').bind(f.release_id ?? ''),
        database.prepare('SELECT count(*) AS n FROM edition_tracks WHERE edition_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(editions)),
      ]);
      const n = (r: D1Result) => (r.results[0] as { n: number }).n;
      if (f.release_id) {
        lines.push(t('作品「{name}」：作品资料（基本信息、译名、{editions} 个版本、{tracks} 首曲目条目）一起删除，里面的 {files} 个文件退回「未归档」。', { name, editions: editions.length, tracks: n(tracks), files: n(files) }));
      } else if (f.edition_id) {
        lines.push(t('版本「{name}」：版本资料（{rows} 行曲目表与标签）一起删除，里面的 {files} 个文件退回「未归档」。', { name, rows: n(rows), files: n(files) }));
      } else {
        lines.push(t('名义「{name}」一起删除，里面的 {files} 个文件退回「未归档」。', { name, files: n(files) }));
      }
    }
    if (lines.length) {
      lines.push(t('文件本身不删；可以在修改记录里撤销。确定删除吗？'));
      throw new ConfirmError('{lines}', { lines: lines.join('\n') });
    }
  }
  const first = places.folders.get(list[0])!;
  const parent = first.parent_id ? folderKey(first.parent_id) : null;
  const path = places.path(folderKey(list[0]), t);
  const cs = new ChangeSet(database, actor, list.length > 1
    ? summary('删除 {n} 个文件夹', { n: list.length })
    : first.release_id ? summary('删除作品 {path}（连同作品资料）', { path })
      : first.edition_id ? summary('删除版本 {path}（连同版本资料）', { path })
        : first.era_id ? summary('删除名义 {path}', { path }) : summary('删除文件夹 {path}', { path }));
  for (const id of list) {
    const f = places.folders.get(id)!;
    const sub = places.subtree(id);
    const subJson = JSON.stringify(sub);
    cs.updateFilesWhere('folder_id IN (SELECT value FROM json_each(?))', [subJson], UNPLACE);
    const editions = sub.map((k) => places.folders.get(k)!.edition_id).filter((e): e is string => !!e);
    if (editions.length) cs.deleteWhere('edition_track', 't.edition_id IN (SELECT value FROM json_each(?1))', [JSON.stringify(editions)]);
    if (f.release_id) cs.deleteWhere('track', 't.release_id = ?1', [f.release_id]);
    // Folders children first (the undo restores them parents first).
    cs.deleteWhere('folder', 't.id IN (SELECT value FROM json_each(?1))', [JSON.stringify([...sub].reverse())],
      '(SELECT j.key FROM json_each(?1) j WHERE j.value = t.id)');
    if (editions.length) cs.deleteWhere('edition', 't.id IN (SELECT value FROM json_each(?1))', [JSON.stringify(editions)]);
    for (const e of editions) places.editions.delete(e);
    if (f.release_id) await deleteRelease(cs, f.release_id);
    if (f.era_id) await cs.delete('era', { id: f.era_id });
    for (const k of sub) places.removeFolder(k);
  }
  return done(cs, { parent });
}

/** The rows only a release has (its translations), then the release itself. Its files and folders are handled by the caller. */
async function deleteRelease(cs: ChangeSet, releaseId: string) {
  const { results } = await db().prepare("SELECT field, lang FROM translations WHERE entity = 'release' AND entity_id = ?").bind(releaseId).all();
  for (const r of results as { field: string; lang: string }[]) {
    await cs.delete('translation', { entity: 'release', entity_id: releaseId, field: r.field, lang: r.lang });
  }
  await cs.delete('release', { id: releaseId });
}

// ------------------------------------------------------------------------------------------ types

export interface TypeOptions {
  form?: string; // release: a release_forms id, or NEW_FORM with new_form
  new_form?: string | null;
  catalog_no?: string | null;
  title?: string | null;
  slot?: string; // edition: a type id, or NEW_TYPE with new_type
  new_type?: string | null;
  name?: string | null; // edition
}

const CATALOG = /^([A-Za-z]{2,}[A-Za-z0-9]*-[0-9]+[A-Za-z]?)\s+(.+)$/;

/** 「RTCD-004 Lengsel」 → catalog RTCD-004, title Lengsel. */
export function guessRelease(name: string): { catalog_no: string | null; title: string } {
  const m = CATALOG.exec(name.trim());
  return m ? { catalog_no: m[1].toUpperCase(), title: m[2].trim() } : { catalog_no: null, title: name.trim() };
}

function slug(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function freeId(table: 'releases' | 'eras', base: string, prefix: string): Promise<string> {
  let id = /^[a-z0-9][a-z0-9-]*$/.test(base) ? base : '';
  if (!id) id = newId(prefix).replace('_', '-');
  for (let i = 2; await db().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first(); i += 1) id = `${base || prefix}-${i}`;
  return id;
}

/**
 * Give a folder a type, or take it away (back to a plain folder). A plain folder becomes an era at the
 * top, a release inside an era, an edition directly inside a release; its files join the new release or
 * edition. A release or edition turned back into a plain folder keeps its files and name.
 */
export async function setFolderType(actor: string, id: string, type: FolderType, opts: TypeOptions, t: T): Promise<FolderResult> {
  const places = await Places.load();
  const database = db();
  const f = mustFolder(places, id);
  if (f.type === type) return { summary: summary('没有改动'), changed: 0, batchId: null, id };
  if (f.type !== 'plain' && type !== 'plain') throw new UserError('先改回普通文件夹，再设为其他类型');
  const label = places.folderName(f, t);
  const cs = new ChangeSet(database, actor, summary('文件夹 {name} 设为{type}', { name: label, type: t(type === 'plain' ? '普通文件夹' : type === 'era' ? '名义' : type === 'release' ? '作品' : '版本') }));
  const free = f.type === 'plain' ? freeFolders(places, id) : [];
  if (f.type === 'plain' && places.hasBelow(id, ['era', 'release', 'edition'])) throw new UserError('文件夹里有作品或版本，不能设为其他类型');
  const before = places.context(id);

  if (type === 'era') {
    if (f.parent_id) throw new UserError('名义只能放在最顶层');
    const eraId = await freeId('eras', slug(f.name), 'era');
    const sort = Math.max(0, ...[...places.eras.values()].map((e) => e.sort)) + 1;
    cs.create('era', { id: eraId, name: f.name, years: null, sort });
    cs.updateKnown('folder', { id }, row(f), { type: 'era', era_id: eraId });
  } else if (type === 'release') {
    const ctx = places.context(f.parent_id);
    if (!ctx.era_id) throw new UserError('作品要放在某个名义里（中间可以隔着普通文件夹）');
    if (ctx.release_id) throw new UserError('作品不能放进另一个作品或版本里');
    const form = chosenForm(cs, await loadForms(database), opts.form ?? 'album', opts.new_form);
    const kind = kindOf(form);
    const guess = guessRelease(f.name);
    const title = (opts.title ?? '').trim() || guess.title;
    const catalog = opts.catalog_no === undefined ? guess.catalog_no : (opts.catalog_no ?? '').trim() || null;
    if (!title) throw new UserError('标题不能为空');
    if (catalog && (await database.prepare('SELECT 1 FROM releases WHERE catalog_no = ?').bind(catalog).first())) {
      throw new UserError('编号 {no} 已被其他作品使用', { no: catalog });
    }
    const releaseId = await freeId('releases', slug(catalog ?? title), 'r');
    cs.create('release', { id: releaseId, catalog_no: catalog, era_id: ctx.era_id, kind, form, title, aliases: '[]', links: '{}', state: 'draft' });
    cs.updateKnown('folder', { id }, row(f), { type: 'release', release_id: releaseId });
    places.addRelease({ id: releaseId, era_id: ctx.era_id, catalog_no: catalog, title, release_date: null, kind, state: 'draft' });
    places.updateFolder(id, { type: 'release', release_id: releaseId });
    refile(cs, places, free, before, places.context(id));
  } else if (type === 'edition') {
    const parent = f.parent_id ? places.folders.get(f.parent_id) : undefined;
    if (parent?.type !== 'release' || !parent.release_id) throw new UserError('版本只能放在作品的下一层');
    const slot = opts.slot === NEW_TYPE ? addType(cs, places.types, opts.new_type ?? '') : opts.slot ?? '';
    if (!places.types.has(slot)) throw new UserError('请选择版本类型');
    const name = (opts.name ?? f.name).trim();
    if (name.length > 100) throw new UserError('内容过长');
    const siblings = [...places.editions.values()].filter((e) => e.release_id === parent.release_id);
    if (siblings.some((e) => e.slot === slot && e.name === name)) throw new UserError('这个作品已经有同类型、同名的版本');
    const editionId = newId('e');
    const edition = { id: editionId, release_id: parent.release_id, slot, name, catalog_no: null, release_date: null, status: 'collected' as const, sort: siblings.length, is_default: 0 };
    cs.create('edition', { ...edition, external_ids: '{}' });
    cs.updateKnown('folder', { id }, row(f), { type: 'edition', edition_id: editionId });
    places.addEdition(edition);
    places.updateFolder(id, { type: 'edition', edition_id: editionId });
    const after = places.context(id);
    refile(cs, places, free, before, after);
    await markFilled(cs, places, free, after);
  } else {
    // Back to a plain folder, named as it was shown.
    const sub = places.subtree(id);
    if (f.era_id && places.hasBelow(id, ['release'])) throw new UserError('名义里还有作品，不能改回普通文件夹');
    if (f.release_id) {
      const r = places.releases.get(f.release_id)!;
      if (r.state === 'published') throw new UserError('作品已发布，先改回草稿');
      const tracks = await database.prepare('SELECT count(*) AS n FROM tracks WHERE release_id = ?').bind(r.id).first<{ n: number }>();
      if (tracks?.n) throw new UserError('作品已有曲目表，不能改回普通文件夹；可以先在作品页删除曲目');
    }
    const subJson = JSON.stringify(sub);
    if (f.release_id) cs.updateFilesWhere('folder_id IN (SELECT value FROM json_each(?))', [subJson], { release_id: null, edition_id: null, slot: null, track_id: null });
    else if (f.edition_id) cs.updateFilesWhere('folder_id IN (SELECT value FROM json_each(?))', [subJson], { edition_id: null, slot: null });
    // Typed folders below (a release's editions) become plain folders too.
    const typed = sub.map((k) => places.folders.get(k)!).filter((x) => x.type !== 'plain').reverse();
    for (const x of typed) {
      cs.updateKnown('folder', { id: x.id }, row(x), { type: 'plain', era_id: null, release_id: null, edition_id: null, name: places.folderName(x, t) });
    }
    const editions = typed.map((x) => x.edition_id).filter((e): e is string => !!e);
    if (editions.length) {
      cs.deleteWhere('edition_track', 't.edition_id IN (SELECT value FROM json_each(?1))', [JSON.stringify(editions)]);
      cs.deleteWhere('edition', 't.id IN (SELECT value FROM json_each(?1))', [JSON.stringify(editions)]);
    }
    if (f.release_id) await deleteRelease(cs, f.release_id);
    if (f.era_id) await cs.delete('era', { id: f.era_id });
    if (f.edition_id) for (const e of editions) places.editions.delete(e);
  }
  return done(cs, { id });
}

// ------------------------------------------------------------------------------------------ 快速访问

export interface QuickItem { folder_id: string; sort: number }

export async function loadQuickAccess(admin: string): Promise<string[]> {
  const { results } = await db().prepare('SELECT folder_id FROM quick_access WHERE admin = ? ORDER BY sort, folder_id').bind(admin).all<{ folder_id: string }>();
  return results.map((r) => r.folder_id);
}

export async function pinFolder(admin: string, folderId: string, pin: boolean): Promise<void> {
  if (!pin) {
    await db().prepare('DELETE FROM quick_access WHERE admin = ? AND folder_id = ?').bind(admin, folderId).run();
    return;
  }
  if (!(await db().prepare('SELECT 1 FROM folders WHERE id = ?').bind(folderId).first())) throw new UserError('找不到这个文件夹');
  const n = await db().prepare('SELECT count(*) AS n, max(sort) AS top FROM quick_access WHERE admin = ?').bind(admin).first<{ n: number; top: number | null }>();
  if ((n?.n ?? 0) >= 30) throw new UserError('快速访问最多 {n} 个', { n: 30 });
  await db().prepare('INSERT OR IGNORE INTO quick_access (admin, folder_id, sort) VALUES (?, ?, ?)').bind(admin, folderId, (n?.top ?? 0) + 10).run();
}

export async function reorderQuickAccess(admin: string, order: string[]): Promise<void> {
  await db().batch(order.map((id, i) => db().prepare('UPDATE quick_access SET sort = ? WHERE admin = ? AND folder_id = ?').bind((i + 1) * 10, admin, id)));
}
