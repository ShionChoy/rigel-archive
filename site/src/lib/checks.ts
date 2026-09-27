// 检查清单: common organizing mistakes found by queries, each with a link to where it is fixed.

import { SLOT_LABELS } from './constants';
import { db, parseFormat } from './db';
import { N_, type T } from './i18n';
import { titleKey } from './tracks';
import { VISIBLE } from './locations';

export interface CheckItem {
  label: string;
  href: string;
  detail?: string;
}

export interface Check {
  id: string;
  title: string; // a text to translate
  hint: string; // what to do (a text to translate)
  items: CheckItem[];
  more: number; // items not listed
}

const LIMIT = 100;

function cap(items: CheckItem[]): { items: CheckItem[]; more: number } {
  return { items: items.slice(0, LIMIT), more: Math.max(0, items.length - LIMIT) };
}

type EditionInfo = { id: string; slot: string; name: string; release_id: string; catalog_no: string | null; title: string };
const editionLabel = (e: EditionInfo, t: T) => `${e.catalog_no ?? e.title} · ${t(SLOT_LABELS[e.slot as keyof typeof SLOT_LABELS])}${e.name ? ` · ${e.name}` : ''}`;

export async function runChecks(t: T): Promise<Check[]> {
  const database = db();
  const [counts, noLog, dirs, unlinked, noCover, sure, tagRows, emptyFolders] = await database.batch([
    // Editions whose track order has another number of tracks than published.
    database.prepare(
      `SELECT e.id, e.slot, e.name, e.release_id, r.catalog_no, r.title, e.track_count AS declared,
              (SELECT count(*) FROM edition_tracks et WHERE et.edition_id = e.id) AS n
       FROM editions e JOIN releases r ON r.id = e.release_id
       WHERE e.track_count IS NOT NULL AND e.track_count != (SELECT count(*) FROM edition_tracks et WHERE et.edition_id = e.id)
         AND EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = e.id)`,
    ),
    // CD rips without an EAC / XLD log.
    database.prepare(
      `SELECT e.id, e.slot, e.name, e.release_id, r.catalog_no, r.title FROM editions e JOIN releases r ON r.id = e.release_id
       WHERE e.slot = 'cd_rip' AND EXISTS (SELECT 1 FROM files f WHERE f.edition_id = e.id AND f.kind = 'audio' AND f.sealed_in IS NULL)
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.edition_id = e.id AND lower(f.ext) = 'log')`,
    ),
    // Folders named after a format, and the formats really in them.
    database.prepare(
      `SELECT dir, group_concat(DISTINCT lower(ext)) AS exts, count(*) AS n, min(id) AS id FROM files
       WHERE kind = 'audio' AND ${VISIBLE} AND state != 'ignored' GROUP BY dir`,
    ),
    // Audio in an edition that has a track order but is not linked to a track.
    database.prepare(
      `SELECT f.id, f.name, f.edition_id FROM files f
       WHERE f.kind = 'audio' AND f.edition_id IS NOT NULL AND f.track_id IS NULL AND f.sealed_in IS NULL AND f.state != 'ignored' AND f.dup_of IS NULL
         AND EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = f.edition_id)
         AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)
       ORDER BY f.edition_id, f.name`,
    ),
    // Editions with audio but no cover (neither their own nor the release's).
    database.prepare(
      `SELECT e.id, e.slot, e.name, e.release_id, r.catalog_no, r.title FROM editions e JOIN releases r ON r.id = e.release_id
       WHERE e.cover_file_id IS NULL AND r.cover_file_id IS NULL
         AND EXISTS (SELECT 1 FROM files f WHERE f.edition_id = e.id AND f.kind = 'audio' AND f.sealed_in IS NULL)`,
    ),
    // Unplaced files whose suggestion is sure (80% or more).
    database.prepare(
      `SELECT dir, count(*) AS n FROM files
       WHERE ${VISIBLE} AND release_id IS NULL AND folder_id IS NULL AND state = 'inbox'
         AND json_extract(suggest, '$.confidence') >= 0.8 GROUP BY dir ORDER BY n DESC`,
    ),
    // Files whose own title tag differs from what the edition calls the track.
    database.prepare(
      `SELECT f.id, f.name, f.format, et.title AS et_title, t.title AS entry_title, t.version_label, f.edition_id
       FROM files f JOIN edition_tracks et ON et.edition_id = f.edition_id AND et.track_id = f.track_id
       JOIN tracks t ON t.id = f.track_id
       WHERE f.kind = 'audio' AND f.sealed_in IS NULL AND json_extract(f.format, '$.tags.title') IS NOT NULL`,
    ),
    // Folders with nothing in them.
    database.prepare(
      `SELECT id, name FROM folders fd WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.folder_id = fd.id)
         AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = fd.id)`,
    ),
  ]);

  const checks: Check[] = [];
  const edItem = (e: EditionInfo, detail?: string): CheckItem => ({ label: editionLabel(e, t), href: `/admin/editions/${e.id}`, detail });

  checks.push({
    id: 'count', title: N_('版本曲数与声明不符'), hint: N_('核对曲目顺序：可能缺了文件、多了隐藏曲，或声明的曲数有误。'),
    ...cap((counts.results as (EditionInfo & { declared: number; n: number })[]).map((e) => edItem(e, t('声明 {a} 曲，曲目顺序 {b} 行', { a: e.declared, b: e.n })))),
  });
  checks.push({
    id: 'log', title: N_('CD 抓轨没有 LOG'), hint: N_('没有 EAC / XLD 日志就无法确认抓轨质量；有的话放进这个版本。'),
    ...cap((noLog.results as EditionInfo[]).map((e) => edItem(e))),
  });

  const FORMAT_WORDS: [RegExp, string[]][] = [
    [/\bflac\b/i, ['flac']], [/\bwav\b/i, ['wav']], [/\bmp3\b/i, ['mp3']], [/\bm4a\b|\baac\b/i, ['m4a', 'aac']], [/\bogg\b/i, ['ogg']],
  ];
  const mislabelled: CheckItem[] = [];
  for (const d of dirs.results as { dir: string; exts: string; n: number; id: string }[]) {
    const last = d.dir.split('/').at(-1) ?? '';
    const exts = d.exts.split(',');
    const named = FORMAT_WORDS.filter(([re]) => re.test(last));
    if (named.length === 0) continue;
    const allowed = new Set(named.flatMap(([, e]) => e));
    const wrong = exts.filter((e) => !allowed.has(e));
    if (wrong.length) mislabelled.push({ label: d.dir, href: `/admin/inbox?state=all&tree=source&dir=${encodeURIComponent(d.dir)}`, detail: t('目录名写 {named}，实际是 {exts}', { named: [...allowed].join('/').toUpperCase(), exts: exts.join('/').toUpperCase() }) });
  }
  checks.push({ id: 'format', title: N_('目录名与实际格式不符'), hint: N_('确认是不是放错了目录，或目录名写错了。'), ...cap(mislabelled) });

  const tagDiff: CheckItem[] = [];
  for (const r of tagRows.results as { id: string; name: string; format: string; et_title: string | null; entry_title: string; version_label: string | null; edition_id: string }[]) {
    const tag = parseFormat(r.format).tags?.title;
    const mine = r.et_title ?? (r.version_label ? `${r.entry_title} (${r.version_label})` : r.entry_title);
    if (tag && titleKey(tag.replace(/^\d{1,3}\s*[.．)）]\s+/, '')) !== titleKey(mine) && titleKey(tag) !== titleKey(r.entry_title)) {
      tagDiff.push({ label: r.name, href: `/admin/editions/${r.edition_id}#tracks`, detail: t('文件：{tag} · 本站：{mine}', { tag, mine }) });
    }
  }
  checks.push({ id: 'tags', title: N_('内嵌标签与本站不一致'), hint: N_('整理版下载会写入本站的标签；确认本站的曲名是对的，或在版本页「从文件标签导入」。'), ...cap(tagDiff) });

  checks.push({
    id: 'unlinked', title: N_('音频没有对应曲目'), hint: N_('在版本页点「对应文件」，或在文件列表里逐个选择。'),
    ...cap((unlinked.results as { id: string; name: string; edition_id: string }[]).map((f) => ({ label: f.name, href: `/admin/editions/${f.edition_id}#files` }))),
  });
  checks.push({
    id: 'cover', title: N_('版本没有封面'), hint: N_('在版本页选一张图片，或用「查找元数据」从 MusicBrainz、Bandcamp 取回。'),
    ...cap((noCover.results as EditionInfo[]).map((e) => edItem(e))),
  });
  checks.push({
    id: 'sure', title: N_('把握度高的建议还没确认'), hint: N_('这些文件的建议把握度在 80% 以上，可以在整理台「按建议确认」。'),
    ...cap((sure.results as { dir: string; n: number }[]).map((d) => ({ label: d.dir || '/', href: `/admin/inbox?state=inbox&tree=source&dir=${encodeURIComponent(d.dir)}`, detail: t('{n} 个', { n: d.n }) }))),
  });
  checks.push({
    id: 'empty', title: N_('空文件夹'), hint: N_('没有文件也没有子文件夹；不需要的话在整理台删除。'),
    ...cap((emptyFolders.results as { id: string; name: string }[]).map((f) => ({ label: f.name, href: `/admin/inbox?state=all&loc=fd:${f.id}` }))),
  });
  return checks;
}
