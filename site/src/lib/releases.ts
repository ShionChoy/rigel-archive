import { ChangeSet } from './changes';
import {
  ERAS, NEW_RELEASE_SLOTS, RELEASE_KINDS, SLOTS, SLOT_LABELS, SLOT_STATUSES, isOneOf, type ReleaseKind,
} from './constants';
import { db, type ReleaseRow, type SlotRow } from './db';
import { N_, summary, UserError } from './i18n';

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function text(form: FormData, name: string): string | null {
  const value = String(form.get(name) ?? '').trim();
  return value === '' ? null : value;
}

/** A YYYY / YYYY-MM / YYYY-MM-DD field; `message` names the field in the error (a text to translate). */
function date(form: FormData, name: string, message: string, params?: Record<string, string>): string | null {
  const value = text(form, name);
  if (value && !DATE.test(value)) throw new UserError(message, params);
  return value;
}

/** Newline-separated aliases -> JSON array. */
export function parseAliases(raw: string | null): string {
  const list = (raw ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return JSON.stringify([...new Set(list)]);
}

/** Lines of "name URL" -> JSON object. */
export function parseLinks(raw: string | null): string {
  const links: Record<string, string> = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(https?:\/\/\S+)$/);
    if (!match) throw new UserError('链接格式应为「名称 网址」：{line}', { line: trimmed });
    links[match[1]] = match[2];
  }
  return JSON.stringify(links, Object.keys(links).sort());
}

export function linksToText(json: string): string {
  return Object.entries(JSON.parse(json || '{}') as Record<string, string>).map(([k, v]) => `${k} ${v}`).join('\n');
}

export function aliasesToText(json: string): string {
  return (JSON.parse(json || '[]') as string[]).join('\n');
}

export function releaseInfoPatch(form: FormData): Record<string, unknown> {
  const title = text(form, 'title');
  if (!title) throw new UserError('标题不能为空');
  const kind = text(form, 'kind');
  if (!isOneOf(RELEASE_KINDS, kind)) throw new UserError('未知的作品形式');
  const era = text(form, 'era_id');
  if (!ERAS.some((e) => e.id === era)) throw new UserError('未知的名义');
  const trackCount = text(form, 'track_count');
  if (trackCount && !/^\d+$/.test(trackCount)) throw new UserError('曲数应为整数');
  const state = text(form, 'state');
  if (state !== 'draft' && state !== 'published') throw new UserError('未知的发布状态');
  return {
    catalog_no: text(form, 'catalog_no'),
    title,
    title_reading: text(form, 'title_reading'),
    series: text(form, 'series'),
    kind,
    era_id: era,
    release_date: date(form, 'release_date', N_('发行日期格式应为 YYYY、YYYY-MM 或 YYYY-MM-DD')),
    event: text(form, 'event'),
    track_count: trackCount ? Number(trackCount) : null,
    price: text(form, 'price'),
    aliases: parseAliases(text(form, 'aliases')),
    links: parseLinks(text(form, 'links')),
    description: text(form, 'description'),
    note: text(form, 'note'),
    state,
  };
}

export async function saveInfo(actor: string, release: ReleaseRow, form: FormData): Promise<number> {
  const patch = releaseInfoPatch(form);
  if (patch.catalog_no && patch.catalog_no !== release.catalog_no) {
    const clash = await db().prepare('SELECT id FROM releases WHERE catalog_no = ? AND id != ?').bind(patch.catalog_no, release.id).first();
    if (clash) throw new UserError('编号 {no} 已被其他作品使用', { no: String(patch.catalog_no) });
  }
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改基本信息', { release: release.catalog_no ?? release.title }));
  await cs.update('release', { id: release.id }, patch);
  return cs.commit();
}

export async function saveSlots(actor: string, release: ReleaseRow, current: SlotRow[], form: FormData): Promise<number> {
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改版本栏位', { release: release.catalog_no ?? release.title }));
  for (const slot of SLOTS) {
    const status = text(form, `status_${slot}`);
    if (!isOneOf(SLOT_STATUSES, status)) throw new UserError('{slot}：请选择状态', { slot: SLOT_LABELS[slot] });
    const planned = date(form, `planned_${slot}`, N_('{slot}的预定日期格式应为 YYYY、YYYY-MM 或 YYYY-MM-DD'), { slot: SLOT_LABELS[slot] });
    if (status === 'planned' && !planned) throw new UserError('{slot}：「预定」需要填写日期', { slot: SLOT_LABELS[slot] });
    const patch = { status, planned_date: status === 'planned' ? planned : null, note: text(form, `note_${slot}`) };
    const row = current.find((r) => r.slot === slot);
    if (row) cs.updateKnown('release_slot', { release_id: release.id, slot }, row as unknown as Record<string, unknown>, patch);
    else cs.create('release_slot', { release_id: release.id, slot, ...patch });
  }
  return cs.commit();
}

export const TRANSLATED_FIELDS = ['title', 'description'] as const;
export const LANGS = ['zh', 'ja', 'en'] as const;

export async function saveTranslations(actor: string, release: ReleaseRow, form: FormData): Promise<number> {
  const database = db();
  const { results } = await database
    .prepare("SELECT field, lang, value, status FROM translations WHERE entity = 'release' AND entity_id = ?")
    .bind(release.id)
    .all<{ field: string; lang: string; value: string; status: string }>();
  const cs = new ChangeSet(database, actor, summary('作品 {release}：修改译名与介绍', { release: release.catalog_no ?? release.title }));
  for (const field of TRANSLATED_FIELDS) {
    for (const lang of LANGS) {
      const value = text(form, `${field}_${lang}`);
      const key = { entity: 'release', entity_id: release.id, field, lang };
      const existing = results.find((r) => r.field === field && r.lang === lang);
      if (existing && !value) await cs.delete('translation', key);
      else if (existing && value) cs.updateKnown('translation', key, existing, { value });
      else if (value) cs.create('translation', { ...key, value, status: 'approved' });
    }
  }
  return cs.commit();
}

export async function createRelease(actor: string, form: FormData): Promise<string> {
  const id = text(form, 'id');
  if (!id || !SLUG.test(id)) throw new UserError('ID 只能用小写字母、数字和连字符，例如 rtcd-014');
  const patch = releaseInfoPatch(form);
  const database = db();
  if (await database.prepare('SELECT 1 FROM releases WHERE id = ?').bind(id).first()) throw new UserError('ID {id} 已存在', { id });
  if (patch.catalog_no && (await database.prepare('SELECT 1 FROM releases WHERE catalog_no = ?').bind(patch.catalog_no).first())) {
    throw new UserError('编号 {no} 已存在', { no: String(patch.catalog_no) });
  }
  const cs = new ChangeSet(database, actor, summary('新建作品 {release}', { release: String(patch.catalog_no ?? patch.title) }));
  cs.create('release', { id, ...patch });
  // Every slot gets a status right away, so the public page shows placeholders for what is missing.
  const defaults = NEW_RELEASE_SLOTS[patch.kind as ReleaseKind];
  for (const slot of SLOTS) cs.create('release_slot', { release_id: id, slot, status: defaults[slot], planned_date: null, note: null });
  await cs.commit();
  return id;
}

export async function saveCover(actor: string, release: ReleaseRow, form: FormData): Promise<number> {
  const fileId = text(form, 'cover_file_id');
  if (fileId) {
    const file = await db()
      .prepare("SELECT 1 FROM files WHERE id = ? AND release_id = ? AND kind = 'image'")
      .bind(fileId, release.id)
      .first();
    if (!file) throw new UserError('封面要从这个作品的图片文件里选');
  }
  const cs = new ChangeSet(db(), actor, summary(fileId ? N_('作品 {release}：设置封面') : N_('作品 {release}：取消封面'), { release: release.catalog_no ?? release.title }));
  await cs.update('release', { id: release.id }, { cover_file_id: fileId });
  return cs.commit();
}

/**
 * Filing files under a slot whose status is 「缺档」 or 「待确认」 means the slot now has content: mark it
 * 「已收录」 in the same batch (「部分缺档」 and the other statuses are left to the admins).
 */
export async function markCollected(cs: ChangeSet, pairs: Iterable<readonly [string | null | undefined, string | null | undefined]>) {
  const keys = [...new Set([...pairs].filter(([r, s]) => r && s).map(([r, s]) => `${r}/${s}`))];
  if (keys.length === 0) return;
  const { results } = await db()
    .prepare(
      `SELECT release_id, slot, status FROM release_slots
       WHERE status IN ('missing', 'unknown') AND release_id || '/' || slot IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(keys))
    .all<{ release_id: string; slot: string; status: string }>();
  for (const row of results) cs.updateKnown('release_slot', { release_id: row.release_id, slot: row.slot }, row, { status: 'collected' });
}
