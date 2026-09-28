// 智能文件夹: lists of files gathered by conditions, the files themselves staying where they are. The
// presets (把握度高的建议, 疑似重复, 检查清单的各项 …) are defined here; the team's own ones are rows of
// smart_folders, each a set of rules. Not part of the revision log: they change no catalog data.

import { FILE_KIND_LABELS, FILE_STATES, RIGHTS, isOneOf } from './constants';
import { db } from './db';
import { originalGone } from './deletion';
import { N_, UserError } from './i18n';
import { newId } from './ids';
import { UNPLACED_SQL, type Places } from './locations';
import { formatMismatchIds, tagMismatchIds } from './checks';

export const RULE_OPS = {
  contains: N_('包含'),
  not_contains: N_('不包含'),
  starts: N_('开头是'),
  ends: N_('结尾是'),
  is: N_('等于'),
  not: N_('不等于'),
  gt: N_('大于'),
  lt: N_('小于'),
  within: N_('最近几天内'),
  has: N_('有'),
  none: N_('没有'),
  in: N_('在里面'),
  not_in: N_('不在里面'),
  yes: N_('是'),
  no: N_('否'),
  own: N_('与社团自有文件相同'),
  sealed: N_('已整体收藏'),
} as const;
export type RuleOp = keyof typeof RULE_OPS;

type ValueKind = 'text' | 'number' | 'kind' | 'rights' | 'state' | 'origin' | 'suggest' | 'release' | 'folder' | 'none';

export const RULE_FIELDS: Record<string, { label: string; ops: RuleOp[]; value: ValueKind }> = {
  name: { label: N_('文件名'), ops: ['contains', 'not_contains', 'starts', 'ends', 'is'], value: 'text' },
  path: { label: N_('原始路径'), ops: ['contains', 'not_contains', 'starts'], value: 'text' },
  ext: { label: N_('扩展名'), ops: ['is', 'not'], value: 'text' },
  kind: { label: N_('文件类型'), ops: ['is', 'not'], value: 'kind' },
  size: { label: N_('大小（MB）'), ops: ['gt', 'lt'], value: 'number' },
  duration: { label: N_('时长（秒）'), ops: ['gt', 'lt'], value: 'number' },
  rights: { label: N_('权利'), ops: ['is', 'not'], value: 'rights' },
  state: { label: N_('状态'), ops: ['is', 'not'], value: 'state' },
  origin: { label: N_('来源'), ops: ['is'], value: 'origin' },
  added: { label: N_('加入整理台'), ops: ['within'], value: 'number' },
  suggest: { label: N_('规则建议'), ops: ['has', 'none'], value: 'suggest' },
  confidence: { label: N_('建议把握度（%）'), ops: ['gt', 'lt'], value: 'number' },
  suggested_release: { label: N_('建议的作品'), ops: ['is'], value: 'release' },
  folder: { label: N_('所在文件夹（含子文件夹）'), ops: ['in', 'not_in'], value: 'folder' },
  placed: { label: N_('已归档'), ops: ['yes', 'no'], value: 'none' },
  duplicate: { label: N_('有内容相同的副本'), ops: ['yes', 'no'], value: 'none' },
  recording: { label: N_('有同一录音的其他文件'), ops: ['yes', 'own'], value: 'none' },
  archive: { label: N_('压缩包或光盘镜像'), ops: ['yes', 'sealed', 'no'], value: 'none' },
  gone: { label: N_('原件已不存在'), ops: ['yes'], value: 'none' },
};

export const SUGGEST_KINDS = { place: N_('位置'), release: N_('作品'), seal: N_('整体收藏'), rights: N_('权利') } as const;
export const ORIGINS = { nas: N_('合辑'), upload: N_('后台上传') } as const;

export interface Rule {
  field: string;
  op: RuleOp;
  value?: string;
}

export interface RuleSet {
  match: 'all' | 'any';
  rules: Rule[];
}

const S = (field: string) => `json_extract(files.suggest, '$.${field}')`;
const HAS_PLACE = `(${S('release_id')} IS NOT NULL OR ${S('folder')} IS NOT NULL OR ${S('place')} IS NOT NULL)`;

/** SQL (on `files`) for files that have another copy of the same content that is still in use. */
export const HAS_COPY = `(files.sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM files d WHERE d.sha256 = files.sha256 AND d.id != files.id AND d.sealed_in IS NULL AND d.state != 'ignored'))`;
const SAME_RECORDING = (own: boolean) => `(files.sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM acoustic_matches m WHERE (m.a = files.sha256 OR m.b = files.sha256)
  ${own ? "AND EXISTS (SELECT 1 FROM files o WHERE o.sha256 = CASE WHEN m.a = files.sha256 THEN m.b ELSE m.a END AND o.rights = 'own')" : ''}))`;
const ARCHIVE = "(files.kind IN ('archive', 'disc_image') OR json_extract(files.format, '$.archive') IS NOT NULL)";

function textSql(column: string, op: RuleOp, value: string): { sql: string; binds: unknown[] } {
  // instr / substr instead of LIKE: D1 refuses LIKE patterns longer than 50 bytes.
  const v = value.toLowerCase();
  if (op === 'contains') return { sql: `instr(lower(${column}), ?) > 0`, binds: [v] };
  if (op === 'not_contains') return { sql: `instr(lower(${column}), ?) = 0`, binds: [v] };
  if (op === 'starts') return { sql: `substr(lower(${column}), 1, ?) = ?`, binds: [v.length, v] };
  if (op === 'ends') return { sql: `substr(lower(${column}), -?) = ?`, binds: [v.length, v] };
  return { sql: `lower(${column}) = ?`, binds: [v] };
}

function num(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UserError('请填写数字');
  return n;
}

/** The SQL of one rule; checked here, so stored rule sets from older versions cannot inject anything. */
export function ruleSql(rule: Rule, places: Places): { sql: string; binds: unknown[] } {
  const spec = RULE_FIELDS[rule.field];
  if (!spec || !spec.ops.includes(rule.op)) throw new UserError('条件无效');
  const value = (rule.value ?? '').trim();
  if (spec.value === 'text' && !value) throw new UserError('请填写条件的内容');
  const cmp = rule.op === 'gt' ? '>' : '<';
  switch (rule.field) {
    case 'name':
      return textSql('coalesce(files.download_name, files.name)', rule.op, value);
    case 'path':
      return textSql("(files.dir || '/' || files.name)", rule.op, value);
    case 'ext': {
      const list = value.split(/[,\s]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
      return { sql: `lower(files.ext) ${rule.op === 'not' ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`, binds: [JSON.stringify(list)] };
    }
    case 'kind':
      if (!(value in FILE_KIND_LABELS)) throw new UserError('条件无效');
      return { sql: `files.kind ${rule.op === 'not' ? '!=' : '='} ?`, binds: [value] };
    case 'size':
      return { sql: `files.size ${cmp} ?`, binds: [Math.round(num(value) * 1024 * 1024)] };
    case 'duration':
      return { sql: `coalesce(json_extract(files.format, '$.duration'), 0) ${cmp} ?`, binds: [num(value)] };
    case 'rights':
      if (!isOneOf(RIGHTS, value)) throw new UserError('条件无效');
      return { sql: `files.rights ${rule.op === 'not' ? '!=' : '='} ?`, binds: [value] };
    case 'state':
      if (!isOneOf(FILE_STATES, value)) throw new UserError('条件无效');
      return { sql: `files.state ${rule.op === 'not' ? '!=' : '='} ?`, binds: [value] };
    case 'origin':
      if (!(value in ORIGINS)) throw new UserError('条件无效');
      return { sql: 'files.origin = ?', binds: [value] };
    case 'added':
      return { sql: "files.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)", binds: [`-${Math.min(3650, Math.round(num(value)))} days`] };
    case 'suggest': {
      const has = { place: HAS_PLACE, release: `${S('release_id')} IS NOT NULL`, seal: `${S('seal')} = 1`, rights: `${S('rights')} IS NOT NULL` }[value];
      if (!has) throw new UserError('条件无效');
      return { sql: rule.op === 'none' ? `NOT coalesce(${has}, 0)` : has, binds: [] };
    }
    case 'confidence':
      return { sql: `coalesce(${S('confidence')}, 0) ${cmp} ?`, binds: [num(value) / 100] };
    case 'suggested_release':
      return { sql: `${S('release_id')} = ?`, binds: [value] };
    case 'folder': {
      const f = places.folderOf(`fd:${value}`);
      const ids = f ? places.subtree(f.id) : [];
      return { sql: `coalesce(files.folder_id, '') ${rule.op === 'not_in' ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`, binds: [JSON.stringify(ids)] };
    }
    case 'placed':
      return { sql: rule.op === 'yes' ? 'files.folder_id IS NOT NULL' : 'files.folder_id IS NULL', binds: [] };
    case 'duplicate':
      return { sql: rule.op === 'yes' ? HAS_COPY : `NOT ${HAS_COPY}`, binds: [] };
    case 'recording':
      return { sql: SAME_RECORDING(rule.op === 'own'), binds: [] };
    case 'archive':
      return { sql: rule.op === 'sealed' ? 'files.sealed = 1' : rule.op === 'yes' ? ARCHIVE : `NOT ${ARCHIVE}`, binds: [] };
    case 'gone':
      return { sql: originalGone('files'), binds: [] };
  }
  throw new UserError('条件无效');
}

export function ruleSetSql(set: RuleSet, places: Places): { sql: string; binds: unknown[] } {
  if (set.rules.length === 0) return { sql: '1', binds: [] };
  const parts = set.rules.map((r) => ruleSql(r, places));
  return { sql: `(${parts.map((p) => `(${p.sql})`).join(set.match === 'any' ? ' OR ' : ' AND ')})`, binds: parts.flatMap((p) => p.binds) };
}

export function parseRuleSet(raw: unknown): RuleSet {
  const v = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { match?: unknown; rules?: unknown };
  const rules = Array.isArray(v?.rules) ? v.rules : [];
  if (rules.length > 20) throw new UserError('条件最多 {n} 条', { n: 20 });
  return {
    match: v?.match === 'any' ? 'any' : 'all',
    rules: rules.map((r: { field?: unknown; op?: unknown; value?: unknown }) => {
      const field = String(r?.field ?? '');
      const op = String(r?.op ?? '') as RuleOp;
      if (!RULE_FIELDS[field]?.ops.includes(op)) throw new UserError('条件无效');
      const value = r?.value === undefined || r?.value === null ? undefined : String(r.value).slice(0, 200);
      return { field, op, value };
    }),
  };
}

// ------------------------------------------------------------------------------------------ presets

export interface Preset {
  key: string;
  name: string; // a text to translate
  hint: string;
  sql?: string;
  ids?: () => Promise<string[]>; // found by code rather than SQL (the checks that compare texts)
  editions?: true; // lists edition folders, not files
  link?: { href: string; label: string }; // a page with more tools for this list
}

export const PRESETS: Preset[] = [
  { key: 'sure', name: N_('把握度高的建议'), hint: N_('建议把握度在 80% 以上、还没确认的文件，可以直接「按建议归档」。'), sql: `${UNPLACED_SQL} AND ${S('confidence')} >= 0.8` },
  { key: 'unsure', name: N_('把握度低的建议'), hint: N_('建议把握度低于 50%：批量确认时会跳过，请逐个确认或手动移动。'), sql: `${UNPLACED_SQL} AND files.suggest IS NOT NULL AND ${S('confidence')} < 0.5` },
  { key: 'seal', name: N_('建议整体收藏的压缩包'), hint: N_('规则建议整体收藏、还没收藏的压缩包。'), sql: `${S('seal')} = 1 AND files.sealed = 0 AND files.state != 'ignored'` },
  { key: 'sealed', name: N_('整体收藏的包'), hint: N_('已整体收藏的压缩包和光盘镜像；双击可以看包内清单。'), sql: 'files.sealed = 1' },
  { key: 'dups', name: N_('疑似重复'), hint: N_('内容完全相同的多份文件。'), sql: `files.state != 'ignored' AND ${HAS_COPY}`, link: { href: '/admin/duplicates', label: N_('逐组选择保留哪份') } },
  { key: 'recording', name: N_('同一录音'), hint: N_('声学指纹判断为同一录音的文件（不同编码、母带、剪辑）。'), sql: SAME_RECORDING(false) },
  { key: 'third', name: N_('第三方'), hint: N_('权利为第三方的文件：公开站只列条目。'), sql: "files.rights = 'third_party'" },
  { key: 'unknown', name: N_('权利未知'), hint: N_('还没确定权利的文件（放进作品时会自动设为社团自有）。'), sql: "files.rights = 'unknown' AND files.state != 'ignored'" },
  { key: 'recent', name: N_('最近上传'), hint: N_('7 天内在后台上传的文件。'), sql: "files.origin = 'upload' AND files.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')" },
  { key: 'gone', name: N_('原件已不存在'), hint: N_('最近一次导入时合辑里已找不到原件的文件，可以删除。'), sql: originalGone('files') },
  {
    key: 'unlinked', name: N_('音频没有对应曲目'), hint: N_('版本已有曲目顺序、但还没对应到曲目的音频：在版本页点「对应文件」。'),
    sql: `files.kind = 'audio' AND files.edition_id IS NOT NULL AND files.track_id IS NULL AND files.state != 'ignored' AND files.dup_of IS NULL
      AND EXISTS (SELECT 1 FROM edition_tracks et WHERE et.edition_id = files.edition_id)
      AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = files.id)`,
  },
  { key: 'tags', name: N_('标签与本站不一致'), hint: N_('文件内嵌的曲名与本站不同：确认本站的曲名，或在版本页「从文件标签导入」。'), ids: tagMismatchIds },
  { key: 'format', name: N_('目录名与格式不符'), hint: N_('原始目录名写的格式与实际文件不同：确认是不是放错了目录。'), ids: formatMismatchIds },
  { key: 'editions', name: N_('有问题的版本'), hint: N_('曲数与声明不符、CD 抓轨没有 LOG、没有封面的版本。'), editions: true },
];

export const presetOf = (key: string) => PRESETS.find((p) => p.key === key);

// ------------------------------------------------------------------------------------------ the team's own

export interface SmartFolder {
  id: string;
  name: string;
  rules: RuleSet;
  color: string | null;
}

export async function loadSmartFolders(): Promise<SmartFolder[]> {
  const { results } = await db().prepare('SELECT id, name, rules, color FROM smart_folders ORDER BY sort, created_at').all<{ id: string; name: string; rules: string; color: string | null }>();
  return results.map((r) => {
    let rules: RuleSet = { match: 'all', rules: [] };
    try {
      rules = parseRuleSet(r.rules);
    } catch {
      // a rule this version no longer knows: the folder shows everything until it is edited
    }
    return { id: r.id, name: r.name, rules, color: r.color };
  });
}

function checkName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 60) throw new UserError('请填写名称（最多 60 个字）');
  return name;
}

export async function saveSmartFolder(admin: string, id: string | null, rawName: string, rules: RuleSet, places: Places): Promise<string> {
  const name = checkName(rawName);
  if (rules.rules.length === 0) throw new UserError('至少要有一个条件');
  ruleSetSql(rules, places); // refuses rules that cannot be used
  const json = JSON.stringify(rules);
  if (id) {
    const r = await db().prepare('UPDATE smart_folders SET name = ?, rules = ? WHERE id = ?').bind(name, json, id).run();
    if (!r.meta.changes) throw new UserError('找不到这个智能文件夹');
    return id;
  }
  const n = await db().prepare('SELECT count(*) AS n, max(sort) AS top FROM smart_folders').first<{ n: number; top: number | null }>();
  if ((n?.n ?? 0) >= 100) throw new UserError('智能文件夹最多 {n} 个', { n: 100 });
  const newIdValue = newId('sf');
  await db().prepare('INSERT INTO smart_folders (id, name, rules, sort, created_by) VALUES (?, ?, ?, ?, ?)').bind(newIdValue, name, json, (n?.top ?? 0) + 10, admin).run();
  return newIdValue;
}

export async function deleteSmartFolder(id: string): Promise<void> {
  await db().prepare('DELETE FROM smart_folders WHERE id = ?').bind(id).run();
}
