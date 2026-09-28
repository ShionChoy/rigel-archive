// 作品形式: the list of release forms the admins keep (table release_forms, migration 0010): 专辑, 单曲,
// 网络发表 … and any they add. A form only describes and groups releases (the releases list, the release
// and public pages). releases.form holds it; releases.kind (CHECK-bound to the six original forms) follows
// as the nearest original one, «other» for forms added later.

import { ChangeSet } from './changes';
import { db } from './db';
import { summary, UserError, type T } from './i18n';
import { newId } from './ids';

export interface ReleaseForm {
  id: string;
  name_zh: string;
  name_ja: string;
  name_en: string;
  sort: number;
}

/** The forms releases.kind accepts (its CHECK). */
const ORIGINAL = ['album', 'single', 'dl_card', 'web', 'game_bgm', 'other'];

/** releases.kind for a form: the form itself when it is one of the original six, else «other». */
export function kindOf(form: string | null): string {
  return form && ORIGINAL.includes(form) ? form : 'other';
}

/** The name of a form in the admin's language (the Japanese one falls back to the Chinese). */
export function formName(form: Pick<ReleaseForm, 'name_zh' | 'name_ja'>, t: T): string {
  return t.lang === 'ja' ? form.name_ja || form.name_zh : form.name_zh;
}

/** The forms in their order, loaded once per request. */
export class FormList {
  readonly list: ReleaseForm[];
  private readonly byId: Map<string, ReleaseForm>;

  constructor(rows: ReleaseForm[]) {
    this.list = [...rows].sort((a, b) => a.sort - b.sort || a.name_zh.localeCompare(b.name_zh, 'zh'));
    this.byId = new Map(this.list.map((r) => [r.id, r]));
  }

  add(row: ReleaseForm) {
    this.list.push(row);
    this.byId.set(row.id, row);
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.byId.has(id);
  }

  get(id: string): ReleaseForm | undefined {
    return this.byId.get(id);
  }

  label(id: string | null | undefined, t: T): string {
    const form = id ? this.byId.get(id) : undefined;
    return form ? formName(form, t) : id || t('未设置');
  }

  options(t: T): { id: string; label: string }[] {
    return this.list.map((r) => ({ id: r.id, label: formName(r, t) }));
  }
}

export async function loadForms(database: D1Database = db()): Promise<FormList> {
  const { results } = await database.prepare('SELECT id, name_zh, name_ja, name_en, sort FROM release_forms').all<ReleaseForm>();
  return new FormList(results);
}

/** The option of a form select that makes a new form (「＋ 新形式…」). */
export const NEW_FORM = '__new__';

const MAX_NAME = 40;

function cleanName(raw: unknown, required: boolean): string {
  const name = String(raw ?? '').normalize('NFC').trim();
  if (required && !name) throw new UserError('形式名称不能为空');
  if (name.length > MAX_NAME) throw new UserError('形式名称太长（最多 {n} 个字）', { n: MAX_NAME });
  return name;
}

/** A new form made in `cs`; its Japanese and English names start as the Chinese one. Returns its id. */
export function addForm(cs: ChangeSet, forms: FormList, rawName: string): string {
  const name = cleanName(rawName, true);
  if (forms.list.some((r) => r.name_zh === name || r.name_ja === name)) throw new UserError('已经有叫「{name}」的形式', { name });
  const id = newId('rf');
  const sort = Math.max(0, ...forms.list.map((r) => r.sort)) + 1;
  const row: ReleaseForm = { id, name_zh: name, name_ja: name, name_en: name, sort };
  cs.create('release_form', { ...row });
  forms.add(row);
  return id;
}

/** The form a select chose: an existing one, or a new one named in `newName` (made in `cs`). */
export function chosenForm(cs: ChangeSet, forms: FormList, value: string | null | undefined, newName: string | null | undefined): string {
  if (value === NEW_FORM) return addForm(cs, forms, newName ?? '');
  if (!value || !forms.has(value)) throw new UserError('未知的作品形式');
  return value;
}

/** How many releases have each form. */
export async function formUses(): Promise<Map<string, number>> {
  const { results } = await db().prepare('SELECT form AS id, count(*) AS n FROM releases WHERE form IS NOT NULL GROUP BY form').all<{ id: string; n: number }>();
  return new Map(results.map((r) => [r.id, r.n]));
}

export async function createForm(actor: string, name: string): Promise<string> {
  const forms = await loadForms();
  const cs = new ChangeSet(db(), actor, summary('新建作品形式 {name}', { name: cleanName(name, true) }));
  const id = addForm(cs, forms, name);
  await cs.commit();
  return id;
}

/** Rename forms (the forms table on the types page: fields zh_<id>, ja_<id>, en_<id> for each form_id). */
export async function saveForms(actor: string, form: FormData): Promise<number> {
  const forms = await loadForms();
  const cs = new ChangeSet(db(), actor, summary('修改作品形式'));
  const seen = new Set<string>();
  for (const id of form.getAll('form_id').map(String)) {
    const row = forms.get(id);
    if (!row) throw new UserError('形式已被别人修改，请刷新后重试');
    const zh = cleanName(form.get(`zh_${id}`), true);
    if (seen.has(zh)) throw new UserError('已经有叫「{name}」的形式', { name: zh });
    seen.add(zh);
    cs.updateKnown('release_form', { id }, row as unknown as Record<string, unknown>, {
      name_zh: zh,
      name_ja: cleanName(form.get(`ja_${id}`), false) || zh,
      name_en: cleanName(form.get(`en_${id}`), false) || zh,
    });
  }
  return cs.commit();
}

/** A new order (ids first to last). */
export async function reorderForms(actor: string, order: string[]): Promise<number> {
  const forms = await loadForms();
  if (order.length !== forms.list.length || !order.every((id) => forms.has(id))) throw new UserError('形式已被别人修改，请刷新后重试');
  const cs = new ChangeSet(db(), actor, summary('调整作品形式的顺序'));
  order.forEach((id, i) => cs.updateKnown('release_form', { id }, { sort: forms.get(id)!.sort }, { sort: i + 1 }));
  return cs.commit();
}

/** Why a form cannot be deleted now, or null. */
export function formDeleteProblem(uses: number | undefined): UserError | null {
  return uses ? new UserError('还有 {n} 个作品是这个形式，先把它们改成别的形式', { n: uses }) : null;
}

export async function deleteForm(actor: string, id: string, t: T): Promise<string> {
  const forms = await loadForms();
  const row = forms.get(id);
  if (!row) throw new UserError('找不到这个形式');
  const problem = formDeleteProblem((await formUses()).get(id));
  if (problem) throw problem;
  const cs = new ChangeSet(db(), actor, summary('删除作品形式 {name}', { name: formName(row, t) }));
  await cs.delete('release_form', { id });
  await cs.commit();
  return cs.summary;
}
