// 权属 of whole editions at once (版本页「公开站」, 作品页). The public site shows and plays only the files the
// circle owns or has a licence for, lists third-party ones by name and leaves out the ones whose rights are
// not set (lib/public/rules.ts). Files come in with their rights not set and only a confirmed suggestion
// sets them, so an edition filed by hand shows nothing until its rights are set: here, in one undoable change.

import { ChangeSet } from './changes';
import { isOneOf, RIGHTS, RIGHTS_LABELS, type Rights } from './constants';
import { db, type EditionRow, type ReleaseRow } from './db';
import { summary, UserError } from './i18n';
import { FILED_FILE } from './public/rules';

export type RightsCount = Record<Rights, number> & { total: number };

/** The files each edition shows on its own (FILED_FILE), by their rights. */
export async function rightsOf(editionIds: string[]): Promise<Map<string, RightsCount>> {
  const out = new Map<string, RightsCount>(editionIds.map((id) => [id, { own: 0, licensed: 0, third_party: 0, unknown: 0, total: 0 }]));
  if (editionIds.length === 0) return out;
  const { results } = await db()
    .prepare(`SELECT f.edition_id, f.rights, count(*) AS n FROM files f WHERE f.edition_id IN (SELECT value FROM json_each(?)) AND ${FILED_FILE} GROUP BY 1, 2`)
    .bind(JSON.stringify(editionIds))
    .all<{ edition_id: string; rights: Rights; n: number }>();
  for (const r of results) {
    const c = out.get(r.edition_id)!;
    c[r.rights] += r.n;
    c.total += r.n;
  }
  return out;
}

/**
 * Set the rights of these editions' files: the ones not set yet, or (`all`) every one. One edition is named
 * in the history by itself, several by their release. Returns how many files changed.
 */
export async function setRights(
  actor: string, release: Pick<ReleaseRow, 'catalog_no' | 'title'>, editions: Pick<EditionRow, 'id' | 'name'>[], rights: unknown, all: boolean,
): Promise<number> {
  if (!isOneOf(RIGHTS, rights) || rights === 'unknown') throw new UserError('请选择权属');
  if (editions.length === 0) return 0;
  const database = db();
  const { results } = await database
    .prepare(`SELECT f.id FROM files f WHERE f.edition_id IN (SELECT value FROM json_each(?)) AND ${FILED_FILE} AND f.rights != ?${all ? '' : " AND f.rights = 'unknown'"}`)
    .bind(JSON.stringify(editions.map((e) => e.id)), rights)
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  const work = release.catalog_no ?? release.title;
  const params = { n: results.length, rights: RIGHTS_LABELS[rights] };
  const cs = new ChangeSet(database, actor, editions.length === 1
    ? summary('版本 {edition}：{n} 个文件设为「{rights}」', { ...params, edition: `${work} ${editions[0].name}`.trim() })
    : summary('作品 {release}：{n} 个文件设为「{rights}」', { ...params, release: work }));
  cs.updateFiles(results.map((r) => r.id), { rights });
  await cs.commit();
  return results.length;
}
