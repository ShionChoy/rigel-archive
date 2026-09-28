import { ChangeSet } from './changes';
import { RELEASE_KINDS, isOneOf } from './constants';
import { db, type ReleaseRow } from './db';
import { N_, summary, UserError } from './i18n';
import { newId } from './ids';

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
  if (!era) throw new UserError('未知的名义');
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
    artist: text(form, 'artist'),
    state,
  };
}

export interface EraRow { id: string; name: string; sort: number }

export async function loadEras(): Promise<EraRow[]> {
  return (await db().prepare('SELECT id, name, sort FROM eras ORDER BY sort, name').all<EraRow>()).results;
}

async function checkEra(id: unknown) {
  if (!(await db().prepare('SELECT 1 FROM eras WHERE id = ?').bind(id).first())) throw new UserError('未知的名义');
}

/**
 * A release's folder in the 整理台 tree: made under its era's folder when missing, moved there when the
 * era changes (from wherever it was inside the old era).
 */
async function placeReleaseFolder(cs: ChangeSet, releaseId: string, eraId: string) {
  const database = db();
  const [era, folder] = await database.batch([
    database.prepare('SELECT id FROM folders WHERE era_id = ?').bind(eraId),
    database.prepare('SELECT id, parent_id FROM folders WHERE release_id = ?').bind(releaseId),
  ]);
  let eraFolder = (era.results[0] as { id: string } | undefined)?.id;
  if (!eraFolder) {
    eraFolder = newId('fd');
    cs.create('folder', { id: eraFolder, parent_id: null, type: 'era', era_id: eraId, name: '', sort: 0 });
  }
  const current = folder.results[0] as { id: string; parent_id: string } | undefined;
  if (!current) cs.create('folder', { id: newId('fd'), parent_id: eraFolder, type: 'release', release_id: releaseId, name: '', sort: 0 });
  else if (current.parent_id !== eraFolder) cs.updateKnown('folder', { id: current.id }, { parent_id: current.parent_id }, { parent_id: eraFolder });
}

export async function saveInfo(actor: string, release: ReleaseRow, form: FormData): Promise<number> {
  const patch = releaseInfoPatch(form);
  await checkEra(patch.era_id);
  if (patch.catalog_no && patch.catalog_no !== release.catalog_no) {
    const clash = await db().prepare('SELECT id FROM releases WHERE catalog_no = ? AND id != ?').bind(patch.catalog_no, release.id).first();
    if (clash) throw new UserError('编号 {no} 已被其他作品使用', { no: String(patch.catalog_no) });
  }
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改基本信息', { release: release.catalog_no ?? release.title }));
  await cs.update('release', { id: release.id }, patch);
  if (patch.era_id !== release.era_id) await placeReleaseFolder(cs, release.id, String(patch.era_id));
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
  await checkEra(patch.era_id);
  const database = db();
  if (await database.prepare('SELECT 1 FROM releases WHERE id = ?').bind(id).first()) throw new UserError('ID {id} 已存在', { id });
  if (patch.catalog_no && (await database.prepare('SELECT 1 FROM releases WHERE catalog_no = ?').bind(patch.catalog_no).first())) {
    throw new UserError('编号 {no} 已存在', { no: String(patch.catalog_no) });
  }
  const cs = new ChangeSet(database, actor, summary('新建作品 {release}', { release: String(patch.catalog_no ?? patch.title) }));
  cs.create('release', { id, ...patch });
  await placeReleaseFolder(cs, id, String(patch.era_id));
  await cs.commit();
  return id;
}
