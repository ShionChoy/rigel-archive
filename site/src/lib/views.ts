// Filters an admin saved on the 整理台 (「保存当前筛选」). Personal shortcuts, not catalog data, so they
// are not part of the revision log.

import { db } from './db';
import { UserError } from './i18n';
import { newId } from './ids';

export interface SavedView {
  id: string;
  name: string;
  query: string;
}

const MAX_VIEWS = 20;

export async function loadViews(admin: string): Promise<SavedView[]> {
  const { results } = await db()
    .prepare('SELECT id, name, query FROM saved_views WHERE admin = ? ORDER BY sort, created_at')
    .bind(admin)
    .all<SavedView>();
  return results;
}

export async function saveView(admin: string, rawName: string, rawQuery: string): Promise<void> {
  const name = rawName.trim();
  if (!name || name.length > 40) throw new UserError('请填写名称（最多 40 个字）');
  const query = new URLSearchParams(rawQuery);
  for (const k of ['msg', 'err', 'undo', 'page']) query.delete(k);
  const existing = await loadViews(admin);
  if (existing.length >= MAX_VIEWS) throw new UserError('最多保存 {n} 个筛选', { n: MAX_VIEWS });
  const same = existing.find((v) => v.name === name);
  if (same) {
    await db().prepare('UPDATE saved_views SET query = ? WHERE id = ?').bind(query.toString(), same.id).run();
    return;
  }
  await db()
    .prepare('INSERT INTO saved_views (id, admin, name, query, sort) VALUES (?, ?, ?, ?, ?)')
    .bind(newId('v'), admin, name, query.toString(), existing.length)
    .run();
}

export async function deleteView(admin: string, id: string): Promise<void> {
  await db().prepare('DELETE FROM saved_views WHERE id = ? AND admin = ?').bind(id, admin).run();
}
