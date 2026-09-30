// Ctrl+K on any admin page: jump to a page, release, edition, song, folder or file by a few letters of its
// name or catalog number. Matching ignores case, width and accents («aventyr» finds «Äventyr»).

import { db } from './db';
import type { T } from './i18n';
import { Places, folderKey } from './locations';

export interface JumpItem {
  kind: string; // what it is, translated
  label: string;
  sub?: string; // where it is
  href: string;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** 2 = starts with the query, 1 = contains every word of it, 0 = no match. */
function score(text: string, q: string, words: string[]): number {
  const f = fold(text);
  if (f.startsWith(q)) return 2;
  return words.every((w) => f.includes(w)) ? 1 : 0;
}

const PAGES: [string, string][] = [
  ['概览', '/admin'], ['整理台', '/admin/inbox'], ['上传', '/admin/upload'], ['作品', '/admin/releases'], ['乐曲', '/admin/songs'],
  ['缺档看板', '/admin/missing'], ['修改记录', '/admin/history'], ['存储与处理', '/admin/storage'], ['管理组', '/admin/team'],
  ['检查清单', '/admin/checks'], ['重复内容', '/admin/duplicates'], ['作品形式与版本类型', '/admin/types'], ['新建作品', '/admin/releases/new'],
];

export async function jump(raw: string, t: T): Promise<JumpItem[]> {
  const q = fold(raw.trim());
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const places = await Places.load();
  const found: (JumpItem & { rank: number })[] = [];
  const add = (item: JumpItem, text: string, weight: number) => {
    const s = score(text, q, words);
    if (s) found.push({ ...item, rank: weight * 10 + s }); // pages, then releases, editions, songs, folders, files; the name starting with it first
  };
  for (const [name, href] of PAGES) add({ kind: t('页面'), label: t(name), href }, `${t(name)} ${name}`, 5);
  for (const r of places.releases.values()) {
    add({ kind: t('作品'), label: places.releaseLabel(r.id), href: `/admin/releases/${r.id}` }, places.releaseLabel(r.id), 4);
  }
  for (const e of places.editions.values()) {
    const release = places.releaseLabel(e.release_id);
    const label = places.editionLabel(e, t);
    add({ kind: t('版本'), label, sub: release, href: `/admin/editions/${e.id}` }, `${release} ${label} ${e.catalog_no ?? ''}`, 3);
  }
  for (const f of places.folders.values()) {
    if (f.type !== 'plain') continue;
    add({ kind: t('文件夹'), label: f.name, sub: places.path(folderKey(f.id), t), href: `/admin/inbox?loc=${folderKey(f.id)}` }, f.name, 2);
  }
  const database = db();
  const like = words.reduce((w, a) => (a.length > w.length ? a : w), '');
  const [songs, files] = await database.batch([
    database.prepare('SELECT id, title FROM songs'),
    // Files: the longest word narrows it down in the database (ASCII case only); the rest is checked here.
    database
      .prepare(
        `SELECT id, coalesce(download_name, name) AS name, dir FROM files
         WHERE sealed_in IS NULL AND instr(lower(coalesce(download_name, name)), ?) > 0 ORDER BY length(name) LIMIT 200`,
      )
      .bind(like),
  ]);
  for (const s of songs.results as { id: string; title: string }[]) add({ kind: t('乐曲'), label: s.title, href: `/admin/songs/${s.id}` }, s.title, 3);
  let n = 0;
  for (const f of files.results as { id: string; name: string; dir: string }[]) {
    if (n >= 12) break;
    const before = found.length;
    add({ kind: t('文件'), label: f.name, sub: f.dir, href: `/admin/files/${f.id}` }, f.name, 0);
    if (found.length > before) n += 1;
  }
  return found.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label, 'ja')).slice(0, 30).map(({ rank: _, ...item }) => item);
}
