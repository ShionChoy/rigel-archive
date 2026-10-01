// 版本页「公开站」 (设计文档「文件权限方案 · 管理界面」): an edition's access settings and every file it shows,
// with what visitors get from each (lib/access.ts). The edition's defaults are saved with a form; files are
// set one by one or many at once through /admin/editions/<id>/access. Every save is one undoable change.

import { ChangeSet } from './changes';
import {
  accessOf, clipFromInput, clipSpan, EDITION_ACCESS_FIELDS, formatClip, parseClip, PLAYS, QUALITIES, settingsOf,
  type Access, type Play, type Quality,
} from './access';
import { formatClock } from './release-view';
import { isOneOf, RIGHTS, RIGHTS_LABELS, type Rights } from './constants';
import { db, parseFormat, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { N_, summary, UserError, type T } from './i18n';
import type { Places } from './locations';
import { env } from 'cloudflare:workers';
import { clipsFor, dropUnwanted } from './clips';
import { openVersions, playVersions } from './playback';
import { derivedFor } from './processing';
import { ADMIN_URLS } from './media';
import { FILED_FILE } from './public/rules';

export const PLAY_LABELS: Record<Play, string> = { full: N_('允许'), clip: N_('仅试听'), none: N_('不允许') };
export const QUALITY_LABELS: Record<Quality, string> = { original: N_('原件'), lossless: N_('无损'), lossy: N_('省流') };
export const QUALITY_HINTS: Record<Quality, string> = {
  original: N_('原件（最高）'), lossless: N_('无损（推流 FLAC）'), lossy: N_('省流（AAC 256 kbps）'),
};

type AccessFile = Pick<FileRow, 'id' | 'name' | 'download_name' | 'kind' | 'ext' | 'folder_id' | 'track_id' | 'rights' | 'format' | 'size' | 'sha256'
  | 'blob_key' | 'source_path' | 'member_path' | 'pub_visible' | 'pub_play' | 'pub_clip' | 'pub_quality' | 'pub_download'>;

export interface AccessRow {
  id: string;
  name: string;
  kind: string;
  rights: Rights;
  /** «1», «2-03»: its place in the track list. */
  position: string | null;
  access: Access;
  /** The settings before the rights cap them (what the cells show). */
  settings: ReturnType<typeof settingsOf>;
  /** The clip range as typed («30% 起 60 秒»). */
  clipText: string;
  /** What visitors get, in a few words. */
  site: string;
  /** The rights hold back something its settings would open. */
  capped: boolean;
}
export interface AccessGroup { label: string; rows: AccessRow[] }
export interface AccessPanel {
  groups: AccessGroup[];
  counts: { total: number; open: number; listed: number; hidden: number; own: number; capped: number; unknown: number };
  kinds: { kind: string; n: number }[];
}

/** «30% 起 60 秒», «1:30 起 45 秒». */
export function clipText(raw: string | null | undefined, t: T): string {
  const c = parseClip(raw);
  if (!c) return '';
  return t('{start} 起 {n} 秒', { start: c.percent ? `${c.start}%` : formatClock(c.start), n: c.length });
}

/** The edition's files that stand for themselves, with what visitors get from each, grouped as the page lists them. */
export async function accessPanel(edition: EditionRow, places: Places, t: T): Promise<AccessPanel> {
  const database = db();
  const [{ results: files }, { results: rows }] = await Promise.all([
    database
      .prepare(
        `SELECT f.id, f.name, f.download_name, f.kind, f.ext, f.folder_id, f.track_id, f.rights, f.format, f.size, f.sha256, f.blob_key, f.source_path, f.member_path,
                f.pub_visible, f.pub_play, f.pub_clip, f.pub_quality, f.pub_download
         FROM files f WHERE f.edition_id = ? AND ${FILED_FILE} ORDER BY coalesce(f.download_name, f.name)`,
      )
      .bind(edition.id)
      .all<AccessFile>(),
    database.prepare('SELECT track_id, disc, position FROM edition_tracks WHERE edition_id = ? ORDER BY disc, position').bind(edition.id).all<{ track_id: string; disc: number; position: number }>(),
  ]);
  const audio = files.filter((f) => f.kind === 'audio');
  const [derived, clips] = await Promise.all([
    derivedFor(database, audio.map((f) => f.sha256)),
    clipsFor(database, audio.map((f) => f.sha256)),
  ]);
  const multiDisc = rows.some((r) => r.disc > 1);
  const rowOf = new Map(rows.map((r, i) => [r.track_id, { ...r, order: i }]));
  const home = places.editionFolder(edition.id);
  const folderPath = (folderId: string | null) => {
    if (!folderId || !home || folderId === home.id) return '';
    const chain = places.chain(`fd:${folderId}`);
    return chain.slice(chain.indexOf(`fd:${home.id}`) + 1).map((k) => places.name(k, t)).join(' / ');
  };

  const counts = { total: files.length, open: 0, listed: 0, hidden: 0, own: 0, capped: 0, unknown: 0 };
  const kinds = new Map<string, number>();
  const make = (f: AccessFile): AccessRow => {
    const access = accessOf(f, edition);
    const settings = settingsOf(f, edition);
    const capped = access.ceiling !== 'open' && settings.visible && (settings.play !== 'none' || settings.download);
    const track = f.track_id ? rowOf.get(f.track_id) : undefined;
    let site: string;
    if (!access.visible) site = f.rights === 'unknown' ? t('隐藏（权属未定）') : t('隐藏');
    else if (access.play === 'none') site = t('只列名称');
    else if (f.kind === 'audio') {
      const versions = playVersions(f, f.sha256 ? derived.get(f.sha256) : undefined, access, ADMIN_URLS, f.sha256 ? clips.get(f.sha256) : undefined);
      const open = openVersions(versions);
      if (access.play === 'clip') {
        const span = clipSpan(access.clip, parseFormat(f.format).duration ?? null);
        site = open.length ? t('▶ 试听 {from}–{to}', { from: formatClock(span.from), to: formatClock(span.to) }) : t('试听准备中');
      } else {
        site = open.length ? `▶ ${open.map((v) => t(QUALITY_LABELS[v.kind ?? 'lossless'])).join(' / ')}` : t('还没有可播放的版本');
      }
    } else site = f.kind === 'video' ? t('可播放') : f.kind === 'image' || f.kind === 'text' ? t('可查看') : t('只列名称');
    if (access.visible) site += ` · ${access.download ? t('可下载') : t('不可下载')}`;
    if (isOpenHere(access, f.kind)) counts.open += 1;
    else if (access.visible) counts.listed += 1;
    else counts.hidden += 1;
    if (Object.values(settings.own).some(Boolean)) counts.own += 1;
    if (capped) counts.capped += 1;
    if (f.rights === 'unknown') counts.unknown += 1;
    kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    return {
      id: f.id, name: f.download_name || f.name, kind: f.kind, rights: f.rights,
      position: track ? `${multiDisc ? `${track.disc}-` : ''}${String(track.position).padStart(2, '0')}` : null,
      access, settings, clipText: clipText(f.pub_clip ?? edition.pub_clip, t), site, capped,
    };
  };

  const groups: AccessGroup[] = [];
  const tracks = files.filter((f) => f.kind === 'audio' && f.track_id && rowOf.has(f.track_id))
    .sort((a, b) => rowOf.get(a.track_id!)!.order - rowOf.get(b.track_id!)!.order);
  if (tracks.length) groups.push({ label: t('曲目'), rows: tracks.map(make) });
  const rest = files.filter((f) => !tracks.includes(f));
  const paths = [...new Set(rest.map((f) => folderPath(f.folder_id)))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  for (const p of paths) {
    groups.push({ label: p || (tracks.length ? t('本版根目录') : t('文件')), rows: rest.filter((f) => folderPath(f.folder_id) === p).map(make) });
  }
  return { groups, counts, kinds: [...kinds].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n) };
}

/** What visitors get from a file, in a few words (the 整理台's inspector). */
export function accessNote(a: Access, kind: string, t: T): string {
  if (!a.visible) return a.ceiling === 'hidden' ? t('隐藏（权属未定）') : t('隐藏');
  const parts = [a.play === 'none' ? t('只列名称') : a.play === 'clip' ? `${t('仅试听')} ${clipText(formatClip(a.clip), t)}` : kind === 'audio' || kind === 'video' ? t('可播放') : t('可查看')];
  if (kind === 'audio' && a.play !== 'none') parts.push(t('音质上限：{q}', { q: t(QUALITY_LABELS[a.quality]) }));
  parts.push(a.download ? t('可下载') : t('不可下载'));
  return parts.join(' · ');
}

/** An edition's settings that differ from opening everything, in a few words (the release page's list). */
export function editionAccessNotes(e: EditionRow, t: T): string[] {
  const out: string[] = [];
  if (e.pub_shown === 0) return [t('不在公开站显示')];
  if (e.pub_visible === 0) out.push(t('文件默认隐藏'));
  if (e.pub_play === 'none') out.push(t('不可在线播放'));
  if (e.pub_play === 'clip') out.push(`${t('仅试听')} ${clipText(e.pub_clip, t)}`);
  if (e.pub_quality !== 'original') out.push(t('音质上限：{q}', { q: t(QUALITY_LABELS[e.pub_quality as Quality] ?? e.pub_quality) }));
  if (e.pub_download === 0) out.push(t('不可下载'));
  return out;
}

/** Open on the public site: played (fully or as a clip), shown or read. */
const isOpenHere = (a: Access, kind: string) => a.visible && a.play !== 'none' && (kind === 'audio' || kind === 'video' || kind === 'image' || kind === 'text');

// ------------------------------------------------------------------------------------------ saving

const workName = (release: Pick<ReleaseRow, 'catalog_no' | 'title'>, edition: Pick<EditionRow, 'name'>) => `${release.catalog_no ?? release.title} ${edition.name}`.trim();

/** A clip range from the two boxes of a form (start, length); a UserError when it is not one. */
export function clipOf(start: unknown, length: unknown): string {
  const clip = clipFromInput(String(start ?? ''), String(length ?? ''));
  if (!clip) throw new UserError('试听范围无效：起点填时间（如 1:30）或百分比（如 30%），长度填 10–600 秒');
  return clip;
}

/** Save the edition's 「在公开站显示本版」 and its files' default access (the page's form). */
export async function saveEditionAccess(actor: string, release: Pick<ReleaseRow, 'catalog_no' | 'title'>, edition: EditionRow, form: FormData): Promise<number> {
  const play = String(form.get('pub_play') ?? '');
  const quality = String(form.get('pub_quality') ?? '');
  if (!isOneOf(PLAYS, play) || !isOneOf(QUALITIES, quality)) throw new UserError('未知的设置');
  const patch = {
    pub_shown: form.get('pub_shown') ? 1 : 0,
    pub_visible: form.get('pub_visible') === '0' ? 0 : 1,
    pub_play: play,
    pub_clip: play === 'clip' || form.get('clip_start') !== null ? clipOf(form.get('clip_start'), form.get('clip_length')) : edition.pub_clip,
    pub_quality: quality,
    pub_download: form.get('pub_download') === '0' ? 0 : 1,
  };
  const cs = new ChangeSet(db(), actor, summary(N_('版本 {edition}：修改公开设置'), { edition: workName(release, edition) }));
  const current = Object.fromEntries(EDITION_ACCESS_FIELDS.map((f) => [f, edition[f]]));
  cs.updateKnown('edition', { id: edition.id }, current, patch);
  const n = await cs.commit();
  if (n && (patch.pub_play !== edition.pub_play || patch.pub_clip !== edition.pub_clip || patch.pub_visible !== edition.pub_visible)) {
    await dropClipsOf(`SELECT DISTINCT sha256 FROM files WHERE edition_id = ? AND kind = 'audio' AND sha256 IS NOT NULL`, [edition.id]);
  }
  return n;
}

/** Preview clips the files no longer want (another range, played in full now) go once the change is saved. */
async function dropClipsOf(sql: string, binds: unknown[]) {
  const { results } = await db().prepare(sql).bind(...binds).all<{ sha256: string }>();
  await dropUnwanted(db(), env.MEDIA, results.map((r) => r.sha256)).catch((e) => console.error('dropping clips failed:', e));
}

/** What a request may set on files: a value, or null to follow the edition again. */
export type FilePatch = Partial<Record<'rights' | 'pub_visible' | 'pub_play' | 'pub_clip' | 'pub_quality' | 'pub_download', string | number | null>>;

const FIELD_LABELS: Record<keyof FilePatch, string> = {
  rights: N_('权属'), pub_visible: N_('可见'), pub_play: N_('在线播放'), pub_clip: N_('试听范围'), pub_quality: N_('音质上限'), pub_download: N_('下载'),
};

/** Check a patch from the page; `inherit` (or null) clears a setting. */
export function cleanPatch(raw: Record<string, unknown>): FilePatch {
  const out: FilePatch = {};
  const inherit = (v: unknown) => v === null || v === 'inherit';
  for (const [key, v] of Object.entries(raw)) {
    switch (key) {
      case 'rights':
        if (!isOneOf(RIGHTS, v)) throw new UserError('请选择权属');
        out.rights = v;
        break;
      case 'pub_visible':
      case 'pub_download':
        out[key] = inherit(v) ? null : v === 1 || v === '1' ? 1 : v === 0 || v === '0' ? 0 : (() => { throw new UserError('未知的设置'); })();
        break;
      case 'pub_play':
        if (!inherit(v) && !isOneOf(PLAYS, v)) throw new UserError('未知的设置');
        out.pub_play = inherit(v) ? null : (v as string);
        break;
      case 'pub_quality':
        if (!inherit(v) && !isOneOf(QUALITIES, v)) throw new UserError('未知的设置');
        out.pub_quality = inherit(v) ? null : (v as string);
        break;
      case 'pub_clip':
        if (inherit(v)) out.pub_clip = null;
        else if (typeof v === 'object' && v) out.pub_clip = clipOf((v as { start?: unknown }).start, (v as { length?: unknown }).length);
        else if (parseClip(String(v))) out.pub_clip = String(v);
        else throw new UserError('试听范围无效：起点填时间（如 1:30）或百分比（如 30%），长度填 10–600 秒');
        break;
      default:
        throw new UserError('未知的设置');
    }
  }
  return out;
}

/** A patch in words for the history: «下载：不允许；音质上限：跟随版本». */
function describe(patch: FilePatch, t: T): string {
  const value = (key: keyof FilePatch, v: string | number | null): string => {
    if (v === null) return t('跟随本版');
    if (key === 'rights') return t(RIGHTS_LABELS[v as Rights]);
    if (key === 'pub_visible') return v === 1 ? t('可见') : t('隐藏');
    if (key === 'pub_download') return v === 1 ? t('允许') : t('不允许');
    if (key === 'pub_play') return t(PLAY_LABELS[v as Play]);
    if (key === 'pub_quality') return t(QUALITY_LABELS[v as Quality]);
    return clipText(String(v), t);
  };
  return (Object.entries(patch) as [keyof FilePatch, string | number | null][]).map(([k, v]) => `${t(FIELD_LABELS[k])}：${value(k, v)}`).join('；');
}

/**
 * Set these files' access (and rights) in one undoable change; only files of this edition are touched.
 * Returns how many files changed.
 */
export async function setFileAccess(
  actor: string, release: Pick<ReleaseRow, 'catalog_no' | 'title'>, edition: EditionRow, ids: string[], patch: FilePatch, t: T,
): Promise<number> {
  if (Object.keys(patch).length === 0) throw new UserError('没有要修改的设置');
  if (ids.length === 0) throw new UserError('请先选择文件');
  const database = db();
  const { results } = await database
    .prepare(`SELECT f.id FROM files f WHERE f.edition_id = ? AND f.id IN (SELECT value FROM json_each(?)) AND ${FILED_FILE}`)
    .bind(edition.id, JSON.stringify(ids))
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  const cs = new ChangeSet(database, actor, summary(N_('版本 {edition}：{n} 个文件 {what}'), { edition: workName(release, edition), n: results.length, what: describe(patch, t) }));
  cs.updateFiles(results.map((r) => r.id), patch);
  const n = await cs.commit();
  if (n && ('pub_play' in patch || 'pub_clip' in patch || 'pub_visible' in patch || 'rights' in patch)) {
    await dropClipsOf(`SELECT DISTINCT sha256 FROM files WHERE id IN (SELECT value FROM json_each(?)) AND kind = 'audio' AND sha256 IS NOT NULL`, [JSON.stringify(results.map((r) => r.id))]);
  }
  return n;
}
