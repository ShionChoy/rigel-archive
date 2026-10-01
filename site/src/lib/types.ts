// 版本类型: the list of edition types the admins keep (table slot_types, migration 0008). A type only
// sorts and groups editions (the order of a release's editions, the public page's navigation, the 缺档看板's
// filter); how many editions a release has and what they are called is up to the admins. The 7 built-in
// types keep their ids (cd, cd_rip …), which the import rules and their suggestions use.

import { ChangeSet } from './changes';
import { db } from './db';
import { summary, UserError, type T } from './i18n';
import { newId } from './ids';
import { UNPLACED_SQL } from './locations';

export interface EditionType {
  id: string;
  name_zh: string;
  name_ja: string;
  name_en: string;
  sort: number;
  missing_board: number; // editions of this type are listed on the 缺档看板
}

/** The name of a type in the page's language (the Japanese and English ones fall back to the Chinese). */
export function typeName(type: Pick<EditionType, 'name_zh' | 'name_ja' | 'name_en'>, t: T): string {
  return t.lang === 'ja' ? type.name_ja || type.name_zh : t.lang === 'en' ? type.name_en || type.name_zh : type.name_zh;
}

/** The types in their order, loaded once per request. */
export class TypeList {
  readonly list: EditionType[];
  private readonly byId: Map<string, EditionType>;

  constructor(rows: EditionType[]) {
    this.list = [...rows].sort((a, b) => a.sort - b.sort || a.name_zh.localeCompare(b.name_zh, 'zh'));
    this.byId = new Map(this.list.map((r) => [r.id, r]));
  }

  /** A type made in this request. */
  add(row: EditionType) {
    this.list.push(row);
    this.byId.set(row.id, row);
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.byId.has(id);
  }

  get(id: string): EditionType | undefined {
    return this.byId.get(id);
  }

  /** Position in the list (unknown ids last). */
  index(id: string): number {
    const type = this.byId.get(id);
    return type ? this.list.indexOf(type) : this.list.length;
  }

  label(id: string | null | undefined, t: T): string {
    if (!id) return '';
    const type = this.byId.get(id);
    return type ? typeName(type, t) : id;
  }

  /** «CD 抓轨 · 第 2 版», or the type alone for an edition without a name of its own. */
  editionLabel(e: { slot: string; name: string }, t: T): string {
    const type = this.label(e.slot, t);
    return e.name && e.name !== type ? `${type} · ${e.name}` : type;
  }

  options(t: T): { id: string; label: string }[] {
    return this.list.map((r) => ({ id: r.id, label: typeName(r, t) }));
  }
}

export async function loadTypes(database: D1Database = db()): Promise<TypeList> {
  const { results } = await database.prepare('SELECT id, name_zh, name_ja, name_en, sort, missing_board FROM slot_types').all<EditionType>();
  return new TypeList(results);
}

/** The option of a type select that makes a new type (「＋ 新类型…」). */
export const NEW_TYPE = '__new__';

const MAX_NAME = 40;

function cleanName(raw: unknown, required: boolean): string {
  const name = String(raw ?? '').normalize('NFC').trim();
  if (required && !name) throw new UserError('类型名称不能为空');
  if (name.length > MAX_NAME) throw new UserError('类型名称太长（最多 {n} 个字）', { n: MAX_NAME });
  return name;
}

/**
 * A new type made in `cs` (the new-edition form's 「＋ 新类型…」, the types page). Its Japanese and English
 * names start as the Chinese one. Returns its id.
 */
export function addType(cs: ChangeSet, types: TypeList, rawName: string): string {
  const name = cleanName(rawName, true);
  if (types.list.some((r) => r.name_zh === name || r.name_ja === name)) throw new UserError('已经有叫「{name}」的类型', { name });
  const id = newId('ty');
  const sort = Math.max(0, ...types.list.map((r) => r.sort)) + 1;
  const row: EditionType = { id, name_zh: name, name_ja: name, name_en: name, sort, missing_board: 1 };
  cs.create('edition_type', { ...row });
  types.add(row);
  return id;
}

/** The type a form chose: an existing one, or a new one named in `new_type` (made in `cs`). */
export function chosenType(cs: ChangeSet, types: TypeList, form: FormData, field = 'slot'): string {
  const value = String(form.get(field) ?? '');
  if (value === NEW_TYPE) return addType(cs, types, String(form.get('new_type') ?? ''));
  if (!types.has(value)) throw new UserError('请选择版本类型');
  return value;
}

export interface TypeUse {
  editions: number;
  suggestions: number; // files still to organize whose suggestion names this type
}

/** How many editions and pending suggestions use each type. */
export async function typeUses(): Promise<Map<string, TypeUse>> {
  const database = db();
  const [editions, suggestions] = await database.batch([
    database.prepare('SELECT slot AS id, count(*) AS n FROM editions GROUP BY slot'),
    database.prepare(`SELECT json_extract(suggest, '$.slot') AS id, count(*) AS n FROM files WHERE ${UNPLACED_SQL} AND json_extract(suggest, '$.slot') IS NOT NULL GROUP BY 1`),
  ]);
  const out = new Map<string, TypeUse>();
  const get = (id: string) => out.get(id) ?? out.set(id, { editions: 0, suggestions: 0 }).get(id)!;
  for (const r of editions.results as { id: string; n: number }[]) get(r.id).editions = r.n;
  for (const r of suggestions.results as { id: string; n: number }[]) get(r.id).suggestions = r.n;
  return out;
}

export async function createType(actor: string, name: string): Promise<string> {
  const types = await loadTypes();
  const cs = new ChangeSet(db(), actor, summary('新建版本类型 {name}', { name: cleanName(name, true) }));
  const id = addType(cs, types, name);
  await cs.commit();
  return id;
}

/** Rename types and set whether they show on the 缺档看板 (the types page's table). */
export async function saveTypes(actor: string, form: FormData): Promise<number> {
  const types = await loadTypes();
  const cs = new ChangeSet(db(), actor, summary('修改版本类型'));
  const ids = form.getAll('id').map(String);
  const seen = new Set<string>();
  for (const id of ids) {
    const type = types.get(id);
    if (!type) throw new UserError('类型已被别人修改，请刷新后重试');
    const zh = cleanName(form.get(`zh_${id}`), true);
    if (seen.has(zh)) throw new UserError('已经有叫「{name}」的类型', { name: zh });
    seen.add(zh);
    const patch = {
      name_zh: zh,
      name_ja: cleanName(form.get(`ja_${id}`), false) || zh,
      name_en: cleanName(form.get(`en_${id}`), false) || zh,
      missing_board: form.get(`board_${id}`) === '1' ? 1 : 0,
    };
    cs.updateKnown('edition_type', { id }, type as unknown as Record<string, unknown>, patch);
  }
  return cs.commit();
}

/** A new order (ids first to last). */
export async function reorderTypes(actor: string, order: string[]): Promise<number> {
  const types = await loadTypes();
  if (order.length !== types.list.length || !order.every((id) => types.has(id))) throw new UserError('类型已被别人修改，请刷新后重试');
  const cs = new ChangeSet(db(), actor, summary('调整版本类型的顺序'));
  order.forEach((id, i) => cs.updateKnown('edition_type', { id }, { sort: types.get(id)!.sort }, { sort: i + 1 }));
  return cs.commit();
}

/** Why a type cannot be deleted now, or null. */
export function deleteProblem(use: TypeUse | undefined): UserError | null {
  if (use?.editions) return new UserError('还有 {n} 个版本是这个类型，先把它们改成别的类型', { n: use.editions });
  if (use?.suggestions) return new UserError('还有 {n} 个待整理文件的归档建议用到这个类型，先确认或忽略这些建议', { n: use.suggestions });
  return null;
}

export async function deleteType(actor: string, id: string, t: T): Promise<string> {
  const types = await loadTypes();
  const type = types.get(id);
  if (!type) throw new UserError('找不到这个类型');
  const problem = deleteProblem((await typeUses()).get(id));
  if (problem) throw problem;
  const database = db();
  const cs = new ChangeSet(database, actor, summary('删除版本类型 {name}', { name: typeName(type, t) }));
  await cs.delete('edition_type', { id });
  await cs.commit();
  return cs.summary;
}
