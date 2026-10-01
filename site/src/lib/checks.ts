// 检查清单: common organizing mistakes found by queries, each with a link to where it is fixed.

import { db, parseFormat } from './db';
import { N_, type T } from './i18n';
import { titleKey } from './tracks';
import { parseTags } from './tagging/model';
import { VISIBLE } from './locations';
import { loadTypes, type TypeList } from './types';
import { FILED_FILE, PUBLIC_EDITION, PUBLIC_RELEASE } from './public/rules';

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
const editionLabel = (e: EditionInfo, t: T, types: TypeList) => `${e.catalog_no ?? e.title} · ${types.editionLabel(e, t)}`;

/** SQL (on `editions` e): has audio, but no cover: none of its audio carries a picture and none was chosen. */
const NO_COVER = `e.cover_file_id IS NULL
  AND EXISTS (SELECT 1 FROM files f WHERE f.edition_id = e.id AND f.kind = 'audio' AND f.sealed_in IS NULL)
  AND NOT EXISTS (SELECT 1 FROM files f LEFT JOIN embedded m ON m.sha256 = f.sha256
                  WHERE f.edition_id = e.id AND f.kind = 'audio' AND f.sealed_in IS NULL
                    AND (m.cover IS NOT NULL OR (m.sha256 IS NULL AND json_extract(f.format, '$.cover') = 1)))`;

export async function runChecks(t: T): Promise<Check[]> {
  const database = db();
  const types = await loadTypes(database);
  const [counts, noLog, dirs, unlinked, noCover, sure, tagRows, emptyFolders, unsettled, bare] = await database.batch([
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
      `SELECT dir, group_concat(DISTINCT lower(ext)) AS exts FROM files
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
    // Editions with audio but no cover (no track carries one, none chosen).
    database.prepare(`SELECT e.id, e.slot, e.name, e.release_id, r.catalog_no, r.title FROM editions e JOIN releases r ON r.id = e.release_id WHERE ${NO_COVER}`),
    // Unplaced files whose suggestion is sure (80% or more).
    database.prepare(
      `SELECT dir, count(*) AS n FROM files
       WHERE ${VISIBLE} AND release_id IS NULL AND folder_id IS NULL AND state = 'inbox'
         AND json_extract(suggest, '$.confidence') >= 0.8 GROUP BY dir ORDER BY n DESC`,
    ),
    // Track rows whose downloaded title differs from their track entry.
    database.prepare(TITLE_SQL),
    // Folders with nothing in them (the admins' own; an empty edition folder is a missing edition).
    database.prepare(
      `SELECT id, name FROM folders fd WHERE fd.type = 'plain' AND NOT EXISTS (SELECT 1 FROM files f WHERE f.folder_id = fd.id)
         AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = fd.id)`,
    ),
    // The public site: published works' collected editions with files whose rights are not set (not shown there).
    database.prepare(
      `SELECT e.id, e.slot, e.name, e.release_id, r.catalog_no, r.title, count(*) AS n
       FROM files f JOIN editions e ON e.id = f.edition_id JOIN releases r ON r.id = e.release_id
       WHERE ${PUBLIC_RELEASE} AND ${PUBLIC_EDITION} AND ${FILED_FILE} AND f.rights = 'unknown'
       GROUP BY e.id ORDER BY r.release_date DESC`,
    ),
    // Published works without a collected edition: only their information is public.
    database.prepare(
      `SELECT r.id, r.catalog_no, r.title FROM releases r
       WHERE ${PUBLIC_RELEASE} AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.release_id = r.id AND ${PUBLIC_EDITION})
       ORDER BY r.release_date DESC`,
    ),
  ]);

  const checks: Check[] = [];
  const edItem = (e: EditionInfo, detail?: string): CheckItem => ({ label: editionLabel(e, t, types), href: `/admin/editions/${e.id}`, detail });

  checks.push({
    id: 'count', title: N_('版本曲数与声明不符'), hint: N_('核对曲目顺序：可能缺了文件、多了隐藏曲，或声明的曲数有误。'),
    ...cap((counts.results as (EditionInfo & { declared: number; n: number })[]).map((e) => edItem(e, t('声明 {a} 曲，曲目顺序 {b} 行', { a: e.declared, b: e.n })))),
  });
  checks.push({
    id: 'log', title: N_('CD 抓轨没有 LOG'), hint: N_('没有 EAC / XLD 日志就无法确认抓轨质量；有的话放进这个版本。'),
    ...cap((noLog.results as EditionInfo[]).map((e) => edItem(e))),
  });

  const mislabelled: CheckItem[] = mislabelledDirs(dirs.results as DirExts[]).map((d) => ({
    label: d.dir, href: `/admin/inbox?view=all&dir=${encodeURIComponent(d.dir)}`,
    detail: t('目录名写 {named}，实际是 {exts}', { named: d.named.join('/').toUpperCase(), exts: d.exts.join('/').toUpperCase() }),
  }));
  checks.push({ id: 'format', title: N_('目录名与实际格式不符'), hint: N_('确认是不是放错了目录，或目录名写错了。'), ...cap(mislabelled) });

  const tagDiff: CheckItem[] = titleDifferences(tagRows.results as TitleRow[]).map(({ r, title, mine }) => ({
    label: r.download_name || r.name, href: `/admin/editions/${r.edition_id}#tracks`, detail: t('下载曲名：{title} · 曲目条目：{mine}', { title, mine }),
  }));
  checks.push({ id: 'tags', title: TITLE_CHECK.name, hint: TITLE_CHECK.hint, ...cap(tagDiff) });

  checks.push({
    id: 'unlinked', title: N_('音频没有对应曲目'), hint: N_('在版本页的曲目列表下方点「按曲号、标题和时长自动对应」，或逐个「对应到…」。'),
    ...cap((unlinked.results as { id: string; name: string; edition_id: string }[]).map((f) => ({ label: f.name, href: `/admin/editions/${f.edition_id}#files` }))),
  });
  checks.push({
    id: 'cover', title: N_('版本没有封面'), hint: N_('曲目都没有自带封面，也没有手动指定：在版本页选一张图片，或用「查找元数据」从 MusicBrainz、Bandcamp 取回。'),
    ...cap((noCover.results as EditionInfo[]).map((e) => edItem(e))),
  });
  checks.push({
    id: 'sure', title: N_('把握度高的建议还没确认'), hint: N_('这些文件的建议把握度在 80% 以上，可以在整理台「按建议归档」。'),
    ...cap((sure.results as { dir: string; n: number }[]).map((d) => ({ label: d.dir || '/', href: `/admin/inbox?view=unplaced&dir=${encodeURIComponent(d.dir)}`, detail: t('{n} 个', { n: d.n }) }))),
  });
  checks.push({
    id: 'unsettled', title: N_('已发布的作品里有权属未定的文件'), hint: N_('公开站不显示权属未定的文件：在版本页的「公开站」里一次设为社团自有、已获授权或第三方。'),
    ...cap((unsettled.results as (EditionInfo & { n: number })[]).map((e) => ({ ...edItem(e, t('{n} 个', { n: e.n })), href: `/admin/editions/${e.id}#public` }))),
  });
  checks.push({
    id: 'bare', title: N_('已发布的作品没有已收录的版本'), hint: N_('公开站上只显示这些作品的资料，没有可以播放或查看的内容。'),
    ...cap((bare.results as { id: string; catalog_no: string | null; title: string }[]).map((r) => ({ label: r.catalog_no ? `${r.catalog_no} ${r.title}` : r.title, href: `/admin/releases/${r.id}` }))),
  });
  checks.push({
    id: 'empty', title: N_('空文件夹'), hint: N_('没有文件也没有子文件夹；不需要的话在整理台删除。'),
    ...cap((emptyFolders.results as { id: string; name: string }[]).map((f) => ({ label: f.name, href: `/admin/inbox?loc=fd:${f.id}` }))),
  });
  return checks;
}

// ------------------------------------------------------------------------------------------ for the 整理台

interface DirExts { dir: string; exts: string }
/** Each track row with its main audio file: the title its 整理版 download gets, and its track entry's title. */
const TITLE_SQL = `
  SELECT et.edition_id, et.tags, t.title AS entry_title, t.version_label, f.id, f.name, f.download_name, f.format, m.tags AS own
  FROM edition_tracks et JOIN tracks t ON t.id = et.track_id
  JOIN files f ON f.id = (SELECT x.id FROM files x WHERE x.edition_id = et.edition_id AND x.track_id = et.track_id AND x.kind = 'audio'
                            AND x.sealed_in IS NULL AND x.state != 'ignored' ORDER BY lower(x.ext) = 'flac' DESC, x.size DESC LIMIT 1)
  LEFT JOIN embedded m ON m.sha256 = f.sha256`;
interface TitleRow {
  edition_id: string; tags: string; entry_title: string; version_label: string | null;
  id: string; name: string; download_name: string | null; format: string | null; own: string | null;
}

export const TITLE_CHECK = {
  name: N_('曲名与曲目条目不一致'),
  hint: N_('整理版下载写入的曲名（版本页标签里的「标题」，没改过就是文件自带的）与作品页的曲目条目不同：改其中一边，让两处一致。'),
};

const FORMAT_WORDS: [RegExp, string[]][] = [
  [/\bflac\b/i, ['flac']], [/\bwav\b/i, ['wav']], [/\bmp3\b/i, ['mp3']], [/\bm4a\b|\baac\b/i, ['m4a', 'aac']], [/\bogg\b/i, ['ogg']],
];

/** Original folders named after a format (「FLAC」) that hold audio of another one. */
function mislabelledDirs(rows: DirExts[]): { dir: string; named: string[]; exts: string[] }[] {
  const out: { dir: string; named: string[]; exts: string[] }[] = [];
  for (const d of rows) {
    const last = d.dir.split('/').at(-1) ?? '';
    const exts = d.exts.split(',');
    const named = FORMAT_WORDS.filter(([re]) => re.test(last));
    if (named.length === 0) continue;
    const allowed = new Set(named.flatMap(([, e]) => e));
    if (exts.some((e) => !allowed.has(e))) out.push({ dir: d.dir, named: [...allowed], exts });
  }
  return out;
}

/** Rows whose downloaded title (the row's own, else the file's) differs from the track entry's title. */
function titleDifferences(rows: TitleRow[]): { r: TitleRow; title: string; mine: string }[] {
  const out: { r: TitleRow; title: string; mine: string }[] = [];
  for (const r of rows) {
    const row = parseTags(r.tags);
    const probed = parseFormat(r.format).tags?.title;
    const list = 'title' in row ? row.title : parseTags(r.own).title ?? (probed ? [probed] : []);
    const title = list[0];
    if (!title) continue;
    const mine = r.version_label ? `${r.entry_title} (${r.version_label})` : r.entry_title;
    const bare = titleKey(title.replace(/^\d{1,3}\s*[.．)）]\s+/, ''));
    if (bare !== titleKey(mine) && bare !== titleKey(r.entry_title)) out.push({ r, title, mine });
  }
  return out;
}

/** 智能文件夹「目录名与格式不符」: the audio files in those folders. */
export async function formatMismatchIds(): Promise<string[]> {
  const database = db();
  const { results } = await database
    .prepare(`SELECT dir, group_concat(DISTINCT lower(ext)) AS exts FROM files WHERE kind = 'audio' AND ${VISIBLE} AND state != 'ignored' GROUP BY dir`)
    .all<DirExts>();
  const dirs = mislabelledDirs(results).map((d) => d.dir);
  if (dirs.length === 0) return [];
  const { results: ids } = await database
    .prepare(`SELECT id FROM files WHERE kind = 'audio' AND ${VISIBLE} AND state != 'ignored' AND dir IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(dirs))
    .all<{ id: string }>();
  return ids.map((r) => r.id);
}

/** 智能文件夹「曲名与曲目条目不一致」: the rows' main audio files. */
export async function tagMismatchIds(): Promise<string[]> {
  const { results } = await db().prepare(TITLE_SQL).all<TitleRow>();
  return titleDifferences(results).map((d) => d.r.id);
}

export const EDITION_PROBLEMS = { count: N_('曲数与声明不符'), log: N_('CD 抓轨没有 LOG'), cover: N_('没有封面') } as const;
export type EditionProblem = keyof typeof EDITION_PROBLEMS;

/** Editions with something to fix, for the 「有问题的版本」 list and the marks in the folder tree. */
export async function editionProblems(): Promise<Map<string, EditionProblem[]>> {
  const database = db();
  const [counts, noLog, noCover] = await database.batch([
    database.prepare(
      `SELECT e.id FROM editions e WHERE e.track_count IS NOT NULL
         AND e.track_count != (SELECT count(*) FROM edition_tracks et WHERE et.edition_id = e.id)
         AND EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = e.id)`,
    ),
    database.prepare(
      `SELECT e.id FROM editions e WHERE e.slot = 'cd_rip'
         AND EXISTS (SELECT 1 FROM files f WHERE f.edition_id = e.id AND f.kind = 'audio' AND f.sealed_in IS NULL)
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.edition_id = e.id AND lower(f.ext) = 'log')`,
    ),
    database.prepare(`SELECT e.id FROM editions e WHERE ${NO_COVER}`),
  ]);
  const out = new Map<string, EditionProblem[]>();
  const add = (rows: unknown[], p: EditionProblem) => {
    for (const { id } of rows as { id: string }[]) out.set(id, [...(out.get(id) ?? []), p]);
  };
  add(counts.results, 'count');
  add(noLog.results, 'log');
  add(noCover.results, 'cover');
  return out;
}
