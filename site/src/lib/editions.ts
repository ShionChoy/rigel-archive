// Editions (版本) of a release: each concrete release or source (初版 CD, 第 2 版, Bandcamp, Amazon …)
// with its own track order. The release's tracks (曲目条目) are every track any edition has; an edition's
// disc/position N points at one of them (table edition_tracks). Files filed under an edition are linked
// to the release's tracks (files.track_id), so the same track can be compared across editions.

import { ChangeSet } from './changes';
import { EXTRA_AUDIO, isOneOf } from './constants';
import { db, parseFormat, type EditionRow, type EditionStatus, type EditionTrackRow, type ReleaseRow, type TrackRow } from './db';
import { N_, summary, UserError } from './i18n';
import { newId } from './ids';
import { Places, ensureEntityFolder } from './locations';
import { dropSongs, exactTitleKey, loadTracks, titleFromFile, titleKey, trackNumber } from './tracks';
import { foldLatin } from './titles';
import { waitingAudio } from './processing';
import { chosenType, loadTypes, type TypeList } from './types';
import { parseTags } from './tagging/model';
import { newRowTags } from './rowtags';

export const EDITION_STATUSES = ['collected', 'partial', 'missing', 'planned', 'unknown'] as const;
export const EDITION_STATUS_LABELS: Record<EditionStatus, string> = {
  collected: N_('已收录'),
  partial: N_('部分缺档'),
  missing: N_('缺档'),
  planned: N_('预定'),
  unknown: N_('待确认'),
};

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export interface ExternalIds {
  musicbrainz_release?: string;
  musicbrainz_release_group?: string;
  musicbrainz_recording?: string;
  musicbrainz_track?: string;
  bandcamp?: string;
}

export function parseIds(raw: string | null | undefined): ExternalIds {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as ExternalIds) : {};
  } catch {
    return {};
  }
}

/** A release's editions in order: by type (the types' order), then their own order, then by date. */
export function sortEditions<E extends Pick<EditionRow, 'slot' | 'sort' | 'release_date' | 'name'>>(list: E[], types: TypeList): E[] {
  return [...list].sort((a, b) => types.index(a.slot) - types.index(b.slot) || a.sort - b.sort
    || (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999') || a.name.localeCompare(b.name, 'ja'));
}

export async function loadEditions(releaseId: string, types?: TypeList): Promise<EditionRow[]> {
  const [{ results }, list] = await Promise.all([
    db().prepare('SELECT * FROM editions WHERE release_id = ?').bind(releaseId).all<EditionRow>(),
    types ? Promise.resolve(types) : loadTypes(),
  ]);
  return sortEditions(results, list);
}

function text(form: FormData, name: string, max = 500): string | null {
  const value = String(form.get(name) ?? '').trim();
  if (value.length > max) throw new UserError('内容过长');
  return value === '' ? null : value;
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The editable fields of an edition from its form (`slot`: the type, already checked). */
export function editionPatch(form: FormData, siblings: EditionRow[], self: EditionRow | null, slot: string): Record<string, unknown> {
  const status = text(form, 'status') ?? 'collected';
  if (!isOneOf(EDITION_STATUSES, status)) throw new UserError('未知的状态');
  const date = text(form, 'release_date');
  if (date && !DATE.test(date)) throw new UserError('发行日期格式应为 YYYY、YYYY-MM 或 YYYY-MM-DD');
  const count = text(form, 'track_count');
  if (count && !/^\d{1,3}$/.test(count)) throw new UserError('曲数应为整数');
  const basedOn = text(form, 'based_on');
  if (basedOn && (!siblings.some((e) => e.id === basedOn) || basedOn === self?.id)) throw new UserError('「源于」要选这个作品的其他版本');
  const name = text(form, 'name', 100) ?? '';
  if (siblings.some((e) => e.id !== self?.id && e.slot === slot && e.name === name)) {
    throw new UserError('这个作品已经有同类型、同名的版本');
  }
  const ids = { ...parseIds(self?.external_ids) };
  const mb = text(form, 'musicbrainz_release');
  if (mb && !MBID.test(mb.toLowerCase())) throw new UserError('MusicBrainz 发行 ID 格式不对');
  if (mb) ids.musicbrainz_release = mb.toLowerCase();
  else delete ids.musicbrainz_release;
  const bandcamp = text(form, 'bandcamp');
  if (bandcamp && !/^https:\/\/[a-z0-9-]+\.bandcamp\.com\/(album|track)\/[\w-]+/i.test(bandcamp)) throw new UserError('Bandcamp 链接格式不对');
  if (bandcamp) ids.bandcamp = bandcamp;
  else delete ids.bandcamp;
  return {
    slot, name, status,
    catalog_no: text(form, 'catalog_no', 40),
    release_date: date,
    source: text(form, 'source', 200),
    based_on: basedOn,
    track_count: count ? Number(count) : null,
    // The album name is a tag of the rows now; the edition's own is kept for editions without rows.
    ...(form.has('album_title') ? { album_title: text(form, 'album_title', 300) } : {}),
    note: text(form, 'note', 2000),
    external_ids: JSON.stringify(ids),
  };
}

function label(release: Pick<ReleaseRow, 'catalog_no' | 'title'>): string {
  return release.catalog_no ?? release.title;
}

export async function createEdition(actor: string, release: ReleaseRow, form: FormData): Promise<string> {
  const types = await loadTypes();
  const siblings = await loadEditions(release.id, types);
  const id = newId('e');
  const cs = new ChangeSet(db(), actor, '');
  const slot = chosenType(cs, types, form);
  const patch = editionPatch(form, siblings, null, slot);
  cs.setSummary(summary('作品 {release}：新建版本 {edition}', { release: label(release), edition: String(patch.name || types.get(slot)?.name_zh || slot) }));
  cs.create('edition', { id, release_id: release.id, is_default: 0, cover_file_id: null, sort: siblings.length, ...patch });
  await addEditionFolder(cs, id, release.id, patch);
  await cs.commit();
  return id;
}

/** The folder of an edition made in `cs` (in the 整理台 tree, under its release's folder). */
export async function addEditionFolder(cs: ChangeSet, id: string, releaseId: string, row: Record<string, unknown>) {
  const places = await Places.load();
  places.addEdition({
    id, release_id: releaseId, slot: String(row.slot), name: String(row.name ?? ''), catalog_no: (row.catalog_no as string) ?? null,
    release_date: (row.release_date as string) ?? null, status: (row.status as EditionStatus) ?? 'collected', sort: Number(row.sort ?? 0), is_default: 0,
  });
  ensureEntityFolder(cs, places, `ed:${id}`, true);
}

export async function saveEdition(actor: string, release: ReleaseRow, edition: EditionRow, form: FormData): Promise<number> {
  const types = await loadTypes();
  const siblings = await loadEditions(release.id, types);
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改版本 {edition}', { release: label(release), edition: edition.name || types.get(edition.slot)?.name_zh || edition.slot }));
  const patch = editionPatch(form, siblings, edition, chosenType(cs, types, form));
  const isDefault = form.get('is_default') === '1';
  cs.updateKnown('edition', { id: edition.id }, edition as unknown as Record<string, unknown>, { ...patch, is_default: isDefault ? 1 : 0 });
  if (isDefault) {
    for (const e of siblings) if (e.id !== edition.id && e.is_default) cs.updateKnown('edition', { id: e.id }, { is_default: 1 }, { is_default: 0 });
  }
  // Files keep the type of the edition they are filed under.
  if (patch.slot !== edition.slot) cs.updateFilesWhere('edition_id = ?', [edition.id], { slot: patch.slot });
  return cs.commit();
}

export async function deleteEdition(actor: string, release: ReleaseRow, edition: EditionRow): Promise<void> {
  const database = db();
  const places = await Places.load(database);
  // Its folder and the empty folders in it go with it (the undo brings them back); files have to be moved first.
  const folder = places.editionFolder(edition.id);
  const folders = folder ? places.subtree(folder.id) : [];
  const used = await database
    .prepare('SELECT count(*) AS files FROM files WHERE edition_id = ?1 OR folder_id IN (SELECT value FROM json_each(?2))')
    .bind(edition.id, JSON.stringify(folders))
    .first<{ files: number }>();
  if (used?.files) throw new UserError('版本里还有文件，先移走它们');
  const cs = new ChangeSet(database, actor, summary('作品 {release}：删除版本 {edition}', { release: label(release), edition: edition.name || places.types.get(edition.slot)?.name_zh || edition.slot }));
  if (folders.length) {
    // Children first (the undo restores them parents first).
    cs.deleteWhere('folder', 't.id IN (SELECT value FROM json_each(?1))', [JSON.stringify([...folders].reverse())], '(SELECT j.key FROM json_each(?1) j WHERE j.value = t.id)');
  }
  const { results: rows } = await database.prepare('SELECT id FROM edition_tracks WHERE edition_id = ?').bind(edition.id).all<{ id: string }>();
  for (const r of rows) await cs.delete('edition_track', { id: r.id });
  const { results: children } = await database.prepare('SELECT id FROM editions WHERE based_on = ?').bind(edition.id).all<{ id: string }>();
  for (const c of children) cs.updateKnown('edition', { id: c.id }, { based_on: edition.id }, { based_on: null });
  await cs.delete('edition', { id: edition.id });
  await cs.commit();
}

// ------------------------------------------------------------------------------------------ track order

export interface EditionTrackView extends EditionTrackRow {
  entry_title: string;
  version_label: string | null;
  song_id: string | null;
  credits: string | null;
  entry_duration: number | null;
  entry_ids: string;
}

export async function loadEditionTracks(editionId: string): Promise<EditionTrackView[]> {
  const { results } = await db()
    .prepare(
      `SELECT et.*, t.title AS entry_title, t.version_label, t.song_id, t.credits, t.duration_ms AS entry_duration, t.external_ids AS entry_ids
       FROM edition_tracks et JOIN tracks t ON t.id = et.track_id WHERE et.edition_id = ? ORDER BY et.disc, et.position, et.id`,
    )
    .bind(editionId)
    .all<EditionTrackView>();
  return results;
}

/** The title an edition gives a track: its title tag, else the track's (with its version label). */
export function trackTitle(et: Pick<EditionTrackView, 'entry_title' | 'version_label'> & { tags?: string | null }): string {
  const tag = parseTags(et.tags).title?.[0];
  if (tag) return tag;
  return et.version_label ? `${et.entry_title} (${et.version_label})` : et.entry_title;
}

interface EditionAudio {
  id: string;
  dir: string;
  name: string;
  sha256: string | null;
  pcm_md5: string | null;
  track_id: string | null;
  format: string | null;
  role: string | null;
}

/**
 * The edition's audio files that stand for its tracks (not ignored, not a copy, not an old version). Those
 * marked as not a track (EXTRA_AUDIO: an XFD, a preview cut) are among them; the track list leaves them out.
 */
export async function editionAudio(editionId: string): Promise<EditionAudio[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, dir, name, sha256, pcm_md5, track_id, format, role FROM files f
       WHERE edition_id = ? AND kind = 'audio' AND state != 'ignored' AND dup_of IS NULL AND sealed_in IS NULL
         AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)
       ORDER BY dir, name`,
    )
    .bind(editionId)
    .all<EditionAudio>();
  return results;
}

/**
 * Tracks of this release already heard in these files: the same decoded audio (pcm_md5) or the same
 * recording (acoustic fingerprint covering most of the shorter file) as a file already linked to a track
 * of the release. A file heard in several tracks counts only when those are duplicates of one track (no
 * edition lists two of them): then the one most editions list (the others are offered for merging on the
 * release page); otherwise it is left to the title.
 */
async function heardTracks(releaseId: string, files: EditionAudio[]): Promise<Map<string, string>> {
  if (files.length === 0) return new Map();
  const database = db();
  const { results: placed } = await database
    .prepare('SELECT et.track_id, et.edition_id FROM edition_tracks et JOIN editions e ON e.id = et.edition_id WHERE e.release_id = ? ORDER BY et.edition_id')
    .bind(releaseId)
    .all<{ track_id: string; edition_id: string }>();
  const editionsOf = new Map<string, Set<string>>();
  for (const r of placed) editionsOf.set(r.track_id, (editionsOf.get(r.track_id) ?? new Set()).add(r.edition_id));
  const { results } = await database
    .prepare(
      `WITH mine AS (SELECT value AS id FROM json_each(?2))
       SELECT f.id AS file, g.track_id AS track FROM files f JOIN mine ON mine.id = f.id
       JOIN files g ON g.pcm_md5 = f.pcm_md5 AND g.release_id = ?1 AND g.track_id IS NOT NULL AND g.id != f.id
       WHERE f.pcm_md5 IS NOT NULL
       UNION
       SELECT f.id, g.track_id FROM files f JOIN mine ON mine.id = f.id
       JOIN acoustic_matches m ON f.sha256 IN (m.a, m.b)
       JOIN fingerprints pa ON pa.sha256 = m.a JOIN fingerprints pb ON pb.sha256 = m.b
       JOIN files g ON g.sha256 = CASE WHEN m.a = f.sha256 THEN m.b ELSE m.a END AND g.release_id = ?1 AND g.track_id IS NOT NULL
       WHERE m.matched_ms >= 800 * min(pa.duration, pb.duration) AND m.score >= 0.9`,
    )
    .bind(releaseId, JSON.stringify(files.map((f) => f.id)))
    .all<{ file: string; track: string }>();
  const found = new Map<string, Set<string>>();
  for (const r of results) found.set(r.file, (found.get(r.file) ?? new Set()).add(r.track));
  const listed = (t: string) => editionsOf.get(t) ?? new Set<string>();
  const pick = (tracks: string[]): string | undefined => {
    if (tracks.length === 1) return tracks[0];
    const together = tracks.some((a, i) => tracks.slice(i + 1).some((b) => [...listed(a)].some((e) => listed(b).has(e))));
    return together ? undefined : [...tracks].sort((a, b) => listed(b).size - listed(a).size || a.localeCompare(b))[0];
  };
  const out = new Map<string, string>();
  for (const [file, tracks] of found) {
    const track = pick([...tracks]);
    if (track) out.set(file, track);
  }
  return out;
}

/**
 * Build an edition's track order from its audio files (only while it has none). Files of one track are one
 * row (a FLAC and a WAV of it): the same decoded audio, else the same number and title, else (an unnumbered
 * copy) the same title. Each row is linked to the release's track it already is — by its audio (the same
 * audio or recording as a file linked to it), else by its title (accents, case and punctuation aside; never
 * by its number, which differs between editions with a track more or less) — or to a new track, and its
 * files are linked to that track; no track gets two rows. A whole-disc image (over 25 minutes next to at
 * least three other files) and audio marked as not a track are left out.
 *
 * While some of the files are still being analysed (no audio checksum or fingerprint yet), the audio cannot
 * be compared: it refuses unless `force`, so that the track list is not linked by titles alone by mistake.
 */
export async function generateEditionTracks(actor: string, release: ReleaseRow, edition: EditionRow, force = false): Promise<number> {
  if ((await loadEditionTracks(edition.id)).length) throw new UserError('这个版本已经有曲目顺序了；要重新生成，先删除现有的行');
  const all = (await editionAudio(edition.id)).filter((f) => f.role !== EXTRA_AUDIO);
  const long = (f: EditionAudio) => (parseFormat(f.format).duration ?? 0) > 25 * 60;
  const files = all.length > 3 ? all.filter((f) => !long(f)) : all;
  if (files.length === 0) throw new UserError('这个版本里没有音频文件');
  const waiting = await waitingAudio(db(), edition.id);
  if (waiting && !force) throw new UserError('还有 {n} 个音频在处理（音频校验或声学指纹还没算完），现在生成只能按标题对应已有的曲目条目；几分钟后再试，或选「仍然生成」', { n: waiting });
  const [entries, heard, placed] = await Promise.all([
    loadTracks(release.id),
    heardTracks(release.id, files),
    db().prepare('SELECT et.track_id, count(*) AS n FROM edition_tracks et JOIN editions e ON e.id = et.edition_id WHERE e.release_id = ? GROUP BY et.track_id')
      .bind(release.id).all<{ track_id: string; n: number }>(),
  ]);
  const known = new Set(entries.map((t) => t.id));
  // Titles to tracks: the exact title first (accents, case and punctuation aside), then without notes in
  // brackets; where several tracks have it, the one most editions list.
  const listedBy = new Map(placed.results.map((r) => [r.track_id, r.n]));
  const byExact = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const t of [...entries].sort((a, b) => (listedBy.get(a.id) ?? 0) - (listedBy.get(b.id) ?? 0))) {
    byExact.set(exactTitleKey(t.title), t.id);
    byTitle.set(titleKey(t.title), t.id);
  }
  const groups = new Map<string, { disc: number; track: number | null; title: string; seconds: number | null; files: EditionAudio[] }>();
  const byAudio = new Map<string, string>(); // pcm_md5 → group: a WAV joins the FLAC with the same audio
  const byName = new Map<string, string>(); // title → group: an unnumbered copy joins its numbered twin
  // Numbered files first, so an unnumbered copy joins its numbered twin (the same title, notes in brackets
  // counting, and the same length: not a remaster or a single version next to it).
  const numbered = [...files].sort((a, b) => Number(!trackNumber(a).track) - Number(!trackNumber(b).track));
  for (const f of numbered) {
    const n = trackNumber(f);
    const title = titleFromFile(f);
    const name = exactTitleKey(title);
    const seconds = parseFormat(f.format).duration ?? null;
    const twin = byName.get(name);
    const twinSeconds = twin ? groups.get(twin)!.seconds : null;
    const sameLength = !!twin && (seconds === null || twinSeconds === null || Math.abs(seconds - twinSeconds) <= 2);
    const key = (f.pcm_md5 && byAudio.get(f.pcm_md5)) || (n.track ? `${n.disc}/${n.track}/${name}` : sameLength ? twin! : `t/${name}/${f.id}`);
    const g = groups.get(key) ?? { disc: n.disc, track: n.track, title, seconds, files: [] };
    g.files.push(f);
    groups.set(key, g);
    if (f.pcm_md5 && !byAudio.has(f.pcm_md5)) byAudio.set(f.pcm_md5, key);
    if (!byName.has(name)) byName.set(name, key);
  }
  const ordered = [...groups.values()].sort((a, b) => a.disc - b.disc || (a.track ?? 999) - (b.track ?? 999) || a.title.localeCompare(b.title, 'ja'));
  const era = await db().prepare('SELECT name FROM eras WHERE id = ?').bind(release.era_id).first<{ name: string }>();
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：从 {n} 个文件生成曲目顺序', { edition: `${label(release)} ${edition.name}`.trim(), n: files.length }));
  const counters = new Map<number, number>();
  let nextPosition = entries.reduce((m, t) => Math.max(m, t.position), 0);
  const first = entries.length === 0;
  const used = new Set<string>(); // tracks this edition's rows have taken
  for (const g of ordered) {
    const position = (counters.get(g.disc) ?? 0) + 1;
    counters.set(g.disc, position);
    // Prefer the tags of a lossless file for the title and length.
    const main = [...g.files].sort((a, b) => Number(!!parseFormat(b.format).lossless) - Number(!!parseFormat(a.format).lossless))[0];
    const title = titleFromFile(main);
    const seconds = parseFormat(main.format).duration;
    const free = (id: string | null | undefined): id is string => !!id && known.has(id) && !used.has(id);
    let trackId = g.files.map((f) => f.track_id ?? heard.get(f.id)).find(free)
      ?? [byExact.get(exactTitleKey(title)), byTitle.get(titleKey(title))].find(free);
    if (!trackId) {
      trackId = newId('t');
      const songId = newId('s');
      nextPosition += 1;
      cs.create('song', { id: songId, title, note: null });
      cs.create('track', {
        id: trackId, release_id: release.id, disc: first ? g.disc : 1, position: first ? position : nextPosition, title, song_id: songId,
        version_label: null, duration_ms: seconds ? Math.round(seconds * 1000) : null, credits: null, note: null, external_ids: '{}',
      });
      known.add(trackId);
    }
    used.add(trackId);
    // The row's tags: its title, and what the catalog says about the album (the files' own tags stay under them).
    cs.create('edition_track', {
      id: newId('et'), edition_id: edition.id, disc: g.disc, position, track_id: trackId,
      duration_ms: seconds ? Math.round(seconds * 1000) : null, external_ids: '{}',
      tags: JSON.stringify(newRowTags([], { ...release, era_name: era?.name ?? '' }, edition, title)), cover: null,
    });
    const relink = g.files.filter((f) => f.track_id !== trackId).map((f) => f.id);
    if (relink.length) cs.updateFiles(relink, { track_id: trackId });
  }
  return cs.commit();
}

/**
 * Link the edition's audio files that have no track yet to its rows. Each file goes to the row it fits best:
 * the same audio or recording as the row's track elsewhere, the same title (accents, case and punctuation
 * aside), a length within a few seconds; the file's own track number only settles a tie, since editions
 * with a track more or less number differently. A file that fits two rows equally well is left alone.
 */
export async function matchEditionFiles(actor: string, release: ReleaseRow, edition: EditionRow): Promise<{ matched: number; left: number }> {
  const [rows, all] = await Promise.all([loadEditionTracks(edition.id), editionAudio(edition.id)]);
  if (rows.length === 0) throw new UserError('这个版本还没有曲目顺序');
  const files = all.filter((x) => !x.track_id && x.role !== EXTRA_AUDIO);
  const heard = await heardTracks(release.id, files);
  const groups = new Map<string, string[]>();
  let left = 0;
  for (const f of files) {
    const n = trackNumber(f);
    const seconds = parseFormat(f.format).duration ?? null;
    const name = titleFromFile(f);
    const scored = rows.map((r) => {
      const names = [trackTitle(r), r.entry_title];
      let score = 0;
      let evidence = false;
      if (heard.get(f.id) === r.track_id) {
        score += 10;
        evidence = true;
      }
      if (names.some((x) => exactTitleKey(x) === exactTitleKey(name))) score += 10;
      else if (names.some((x) => titleKey(x) === titleKey(name))) score += 6;
      else if (names.some((x) => {
        const a = titleKey(x);
        const b = titleKey(name);
        return Math.min(a.length, b.length) >= 3 && (a.endsWith(b) || a.startsWith(b) || b.endsWith(a) || b.startsWith(a));
      })) score += 3;
      if (score > 0) evidence = true;
      const ms = r.duration_ms ?? r.entry_duration;
      const gap = seconds && ms ? Math.abs(seconds * 1000 - ms) : null;
      if (gap !== null) {
        score += gap <= 1500 ? 3 : gap <= 3000 ? 2 : gap <= 6000 ? 0 : -6;
        if (gap <= 3000) evidence = true;
      }
      if (n.track === r.position && n.disc === r.disc) score += 1;
      return { r, score: evidence ? score : 0 };
    }).sort((a, b) => b.score - a.score);
    const [best, next] = scored;
    if (!best || best.score < 3 || (next && next.score === best.score)) {
      left += 1;
      continue;
    }
    groups.set(best.r.track_id, [...(groups.get(best.r.track_id) ?? []), f.id]);
  }
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：按标题、音频与时长对应文件', { edition: `${label(release)} ${edition.name}`.trim() }));
  for (const [trackId, ids] of groups) cs.updateFiles(ids, { track_id: trackId });
  const matched = await cs.commit();
  return { matched, left };
}

// ------------------------------------------------------------------------------------------ comparison

/** How a track in one edition relates to the same track in the edition that first had it. */
export type Relation = 'ref' | 'new' | 'same' | 'master' | 'remix' | 'part' | 'other' | 'nofile';

export const RELATION_MARK: Record<Relation, string> = {
  ref: '', new: '+', same: '=', master: '≈', remix: '△', part: '◐', other: '≠', nofile: '',
};

export const RELATION_TEXT: Record<Relation, string> = {
  ref: N_('最早收录这一首的版本'),
  new: N_('这一版新增'),
  same: N_('解码后的音频完全相同'),
  master: N_('同一母带，只是格式、采样率或编码不同'),
  remix: N_('同一编曲，重新混音或母带'),
  part: N_('只有一部分相同（重编、剪辑、加长）'),
  other: N_('听不出相同，多为重录'),
  nofile: N_('曲目表里有，但还没有文件'),
};

interface MatrixFile {
  id: string;
  name: string;
  sha256: string | null;
  pcm_md5: string | null;
  edition_id: string;
  track_id: string;
  duration: number | null; // of the fingerprint (what matched_ms compares with)
  length: number | null; // of the file, for display
}

export interface Cell {
  position: string | null; // "3" or "2-3"; null when the edition has the file but no row for it
  file: MatrixFile | null;
  relation: Relation;
  share?: number; // part: how much of this file matches
  score?: number;
}

/** Why track entries look like one track: the same decoded audio, the same recording, the same title. */
export type DuplicateReason = 'audio' | 'recording' | 'title';

export const DUPLICATE_REASONS: Record<DuplicateReason, string> = {
  audio: N_('解码后的音频完全相同'),
  recording: N_('声学指纹：同一母带'),
  title: N_('标题相同（时长接近）'),
};

/** Track entries of a release that look like one track (no edition lists two of them): to merge. */
export interface DuplicateGroup {
  tracks: { track: TrackRow; editions: string[] }[]; // each with the editions that list it
  title: string; // the title proposed for the merged entry: the one the editions use most
  titles: string[]; // every title the editions give them, most used first
  reasons: DuplicateReason[];
}

export interface Matrix {
  editions: EditionRow[];
  /** One row per track entry; `label` is the title the editions give it now (the first column's), else its own. */
  rows: { track: TrackRow; label: string; cells: (Cell | null)[] }[];
  duplicates: DuplicateGroup[];
}

export function classify(score: number, matchedMs: number, shorter: number): { relation: Relation; share: number } {
  const share = shorter > 0 ? Math.min(1, matchedMs / 1000 / shorter) : 0;
  if (share >= 0.9 && score >= 0.93) return { relation: 'master', share };
  if (share >= 0.9) return { relation: 'remix', share };
  return { relation: 'part', share };
}

/** Row order: each edition's order, with the tracks an edition adds placed after the ones it follows. */
function mergedOrder(tracks: TrackRow[], editions: EditionRow[], rowsOf: Map<string, EditionTrackRow[]>): TrackRow[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const order: string[] = [];
  for (const e of editions) {
    const mine = (rowsOf.get(e.id) ?? []).map((r) => r.track_id);
    const here = new Set(mine);
    let prev = -1;
    for (const id of mine) {
      const at = order.indexOf(id);
      if (at >= 0) {
        prev = at;
        continue;
      }
      let i = prev + 1;
      while (i < order.length && !here.has(order[i])) i += 1;
      order.splice(i, 0, id);
      prev = i;
    }
  }
  for (const t of tracks) if (!order.includes(t.id)) order.push(t.id);
  return order.map((id) => byId.get(id)).filter((t): t is TrackRow => !!t);
}

/** The 版本对照 of a release; `keep` limits it to some of its editions (the public page: the collected ones). */
export async function comparison(releaseId: string, keep?: (e: EditionRow) => boolean): Promise<Matrix> {
  const database = db();
  const [tracks, allEditions, etRows, fileRows] = await Promise.all([
    loadTracks(releaseId),
    loadEditions(releaseId),
    database.prepare('SELECT et.* FROM edition_tracks et JOIN editions e ON e.id = et.edition_id WHERE e.release_id = ? ORDER BY et.disc, et.position').bind(releaseId).all<EditionTrackRow>(),
    database
      .prepare(
        `SELECT f.id, f.name, f.sha256, f.pcm_md5, f.edition_id, f.track_id,
                coalesce(fp.duration, json_extract(f.format, '$.duration')) AS duration, json_extract(f.format, '$.duration') AS length
         FROM files f LEFT JOIN fingerprints fp ON fp.sha256 = f.sha256
         WHERE f.release_id = ? AND f.kind = 'audio' AND f.track_id IS NOT NULL AND f.edition_id IS NOT NULL
           AND f.state != 'ignored' AND f.dup_of IS NULL AND f.sealed_in IS NULL
           AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)`,
      )
      .bind(releaseId)
      .all<MatrixFile>(),
  ]);
  const rowsOf = new Map<string, EditionTrackRow[]>();
  for (const r of etRows.results) rowsOf.set(r.edition_id, [...(rowsOf.get(r.edition_id) ?? []), r]);
  const filesOf = new Map<string, MatrixFile[]>();
  for (const f of fileRows.results) filesOf.set(`${f.edition_id}/${f.track_id}`, [...(filesOf.get(`${f.edition_id}/${f.track_id}`) ?? []), f]);
  // Columns: editions with a track order or linked audio, oldest first.
  const editions = allEditions
    .filter((e) => (!keep || keep(e)) && (rowsOf.has(e.id) || fileRows.results.some((f) => f.edition_id === e.id)))
    .sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999') || allEditions.indexOf(a) - allEditions.indexOf(b));

  const shas = [...new Set(fileRows.results.map((f) => f.sha256).filter(Boolean))] as string[];
  const matches = new Map<string, { score: number; matched_ms: number }>();
  if (shas.length) {
    const { results } = await database
      .prepare('SELECT a, b, score, matched_ms FROM acoustic_matches WHERE a IN (SELECT value FROM json_each(?1)) AND b IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(shas))
      .all<{ a: string; b: string; score: number; matched_ms: number }>();
    for (const m of results) matches.set(`${m.a}/${m.b}`, m);
  }
  const match = (x: MatrixFile, y: MatrixFile) => {
    if (!x.sha256 || !y.sha256) return undefined;
    return matches.get(x.sha256 < y.sha256 ? `${x.sha256}/${y.sha256}` : `${y.sha256}/${x.sha256}`);
  };
  const relate = (ref: MatrixFile, f: MatrixFile): Pick<Cell, 'relation' | 'share' | 'score'> => {
    if ((f.sha256 && f.sha256 === ref.sha256) || (f.pcm_md5 && f.pcm_md5 === ref.pcm_md5)) return { relation: 'same' };
    const m = match(ref, f);
    if (!m) return { relation: 'other' };
    const shorter = Math.min(ref.duration ?? 0, f.duration ?? 0);
    const c = classify(m.score, m.matched_ms, shorter);
    return { relation: c.relation, share: f.duration ? Math.min(1, m.matched_ms / 1000 / f.duration) : c.share, score: m.score };
  };

  const rows = mergedOrder(tracks, editions, rowsOf).map((track) => {
    let ref: MatrixFile | null = null;
    let seen = false;
    const cells = editions.map((e): Cell | null => {
      const et = (rowsOf.get(e.id) ?? []).filter((r) => r.track_id === track.id);
      const file = (filesOf.get(`${e.id}/${track.id}`) ?? [])[0] ?? null;
      if (!et.length && !file) return null;
      const position = et.length ? et.map((r) => (r.disc > 1 ? `${r.disc}-${r.position}` : String(r.position))).join(', ') : null;
      if (!file) {
        seen = true;
        return { position, file: null, relation: 'nofile' };
      }
      if (!ref) {
        const cell: Cell = { position, file, relation: seen || editions.indexOf(e) === 0 ? 'ref' : 'new' };
        ref = file;
        seen = true;
        return cell;
      }
      return { position, file, ...relate(ref, file) };
    });
    // A track first heard in a later edition is new there, unless an earlier column is empty for another reason.
    const firstFile = cells.findIndex((c) => c?.file);
    if (firstFile > 0 && cells[firstFile]?.relation === 'ref') cells[firstFile]!.relation = 'new';
    if (firstFile === 0 && cells[0]) cells[0].relation = 'ref';
    // The title the editions give it now: the first column's row (its title tag), else the entry's own.
    const first = editions.map((e) => (rowsOf.get(e.id) ?? []).find((r) => r.track_id === track.id)).find((r) => !!r);
    const label = (first && parseTags(first.tags).title?.[0]) || entryTitle(track);
    return { track, label, cells };
  });

  return { editions, rows, duplicates: duplicateGroups(tracks, editions, rowsOf, fileRows.results, matches) };
}

const entryTitle = (t: Pick<TrackRow, 'title' | 'version_label'>) => (t.version_label ? `${t.title} (${t.version_label})` : t.title);

/**
 * Track entries that look like one track: never listed side by side in an edition, and the same decoded
 * audio, the same recording (fingerprints: one master, most of either file) or the same title (accents,
 * case and punctuation aside, notes in brackets counting; lengths within 3 seconds when known). Track numbers
 * play no part: editions with a track more or less number differently. Chains of evidence are followed
 * only while no edition would end up listing two members of a group.
 */
function duplicateGroups(
  tracks: TrackRow[], editions: EditionRow[], rowsOf: Map<string, EditionTrackRow[]>, files: MatrixFile[],
  matches: Map<string, { score: number; matched_ms: number }>,
): DuplicateGroup[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const editionsOf = new Map<string, Set<string>>();
  const titlesOf = new Map<string, string[]>();
  const add = (track: string, edition: string) => editionsOf.set(track, (editionsOf.get(track) ?? new Set()).add(edition));
  for (const e of editions) {
    for (const r of rowsOf.get(e.id) ?? []) {
      add(r.track_id, e.id);
      const t = parseTags(r.tags).title?.[0];
      if (t) titlesOf.set(r.track_id, [...(titlesOf.get(r.track_id) ?? []), t]);
    }
  }
  for (const f of files) add(f.track_id, f.edition_id);
  const filesOf = new Map<string, MatrixFile[]>();
  for (const f of files) filesOf.set(f.track_id, [...(filesOf.get(f.track_id) ?? []), f]);
  const lengthOf = (id: string) => byId.get(id)?.duration_ms ?? (filesOf.get(id)?.[0]?.length ? filesOf.get(id)![0].length! * 1000 : null);
  const names = (id: string) => [entryTitle(byId.get(id)!), ...(titlesOf.get(id) ?? [])];

  // Evidence between two entries, the strongest kinds first.
  const edges: { a: string; b: string; why: DuplicateReason; rank: number }[] = [];
  const ids = tracks.map((t) => t.id);
  for (const [i, a] of ids.entries()) {
    for (const b of ids.slice(i + 1)) {
      const fa = filesOf.get(a) ?? [];
      const fb = filesOf.get(b) ?? [];
      if (fa.some((x) => x.pcm_md5 && fb.some((y) => y.pcm_md5 === x.pcm_md5))) edges.push({ a, b, why: 'audio', rank: 0 });
      else if (fa.some((x) => fb.some((y) => {
        if (!x.sha256 || !y.sha256) return false;
        const m = matches.get(x.sha256 < y.sha256 ? `${x.sha256}/${y.sha256}` : `${y.sha256}/${x.sha256}`);
        const shorter = Math.min(x.duration ?? 0, y.duration ?? 0);
        // One master, most of both files (not a full version holding a part of it, nor an XFD).
        return !!m && shorter > 0 && classify(m.score, m.matched_ms, shorter).relation === 'master'
          && Math.max(x.duration ?? 0, y.duration ?? 0) <= 1.2 * shorter;
      }))) edges.push({ a, b, why: 'recording', rank: 1 });
      const ka = new Set(names(a).map(exactTitleKey));
      if (names(b).some((n) => ka.has(exactTitleKey(n)))) {
        const la = lengthOf(a);
        const lb = lengthOf(b);
        if (la === null || lb === null || Math.abs(la - lb) <= 3000) edges.push({ a, b, why: 'title', rank: 2 });
      }
    }
  }
  // Groups: members never listed side by side in one edition.
  const group = new Map(ids.map((id) => [id, new Set([id])]));
  const reasons = new Map<Set<string>, Set<DuplicateReason>>();
  for (const { a, b, why } of edges.sort((x, y) => x.rank - y.rank)) {
    const ga = group.get(a)!;
    const gb = group.get(b)!;
    if (ga !== gb) {
      const shared = [...ga].some((x) => [...gb].some((y) => [...(editionsOf.get(x) ?? [])].some((e) => editionsOf.get(y)?.has(e))));
      if (shared) continue;
      for (const id of gb) {
        ga.add(id);
        group.set(id, ga);
      }
      reasons.set(ga, new Set([...(reasons.get(ga) ?? []), ...(reasons.get(gb) ?? [])]));
      reasons.delete(gb);
    }
    reasons.set(ga, (reasons.get(ga) ?? new Set()).add(why));
  }
  const order = new Map(editions.map((e, i) => [e.id, i]));
  const firstColumn = (id: string) => Math.min(...[...(editionsOf.get(id) ?? [])].map((e) => order.get(e) ?? 999), 999);
  const label = (e: string) => editions.find((x) => x.id === e);
  return [...new Set(group.values())]
    .filter((g) => g.size > 1)
    .map((g) => {
      const members = [...g].sort((x, y) => firstColumn(x) - firstColumn(y) || x.localeCompare(y));
      const counts = new Map<string, number>();
      for (const id of members) for (const n of names(id)) counts.set(n, (counts.get(n) ?? 0) + 1);
      // The most used title; a tie goes to the one with its accents, then the shorter.
      const titles = [...counts].sort((x, y) => y[1] - x[1] || Number(foldLatin(y[0]) !== y[0]) - Number(foldLatin(x[0]) !== x[0])
        || x[0].length - y[0].length || x[0].localeCompare(y[0])).map(([n]) => n);
      return {
        tracks: members.map((id) => ({ track: byId.get(id)!, editions: [...(editionsOf.get(id) ?? [])].filter((e) => label(e)).sort((x, y) => order.get(x)! - order.get(y)!) })),
        title: titles[0], titles, reasons: [...(reasons.get(g) ?? [])].sort(),
      };
    });
}

/**
 * Merge track entries that are one track (版本对照 «可能是同一首»): the editions' rows and the files of the
 * others move to the one kept (the one most editions list, preferring the one already titled so), which
 * takes the chosen title; a row that showed another entry's title keeps it as its own 标题 tag. Songs: the
 * kept entry's song takes the others' tracks and the chosen title (when it was named after these entries),
 * songs left without tracks go. Refused when an edition lists two of them. One undoable change.
 */
export async function mergeTrackGroup(actor: string, release: ReleaseRow, trackIds: string[], title: string): Promise<number> {
  const name = title.trim();
  if (!name) throw new UserError('合并后的标题不能为空');
  const tracks = await loadTracks(release.id);
  const members = [...new Set(trackIds)].map((id) => tracks.find((t) => t.id === id)).filter((t): t is TrackRow => !!t);
  if (members.length < 2) throw new UserError('请至少选择这个作品的两个曲目条目');
  const database = db();
  const ids = JSON.stringify(members.map((t) => t.id));
  const { results: rows } = await database.prepare('SELECT * FROM edition_tracks WHERE track_id IN (SELECT value FROM json_each(?))').bind(ids).all<EditionTrackRow>();
  const byEdition = new Map<string, Set<string>>();
  for (const r of rows) byEdition.set(r.edition_id, (byEdition.get(r.edition_id) ?? new Set()).add(r.track_id));
  const clash = [...byEdition.values()].find((set) => set.size > 1);
  if (clash) {
    const [a, b] = [...clash].map((id) => members.find((t) => t.id === id)!.title);
    throw new UserError('「{a}」和「{b}」同在一个版本的曲目表里，是不同的曲目，不能合并', { a, b });
  }
  const listed = (t: TrackRow) => rows.filter((r) => r.track_id === t.id).length;
  const keep = [...members].sort((x, y) => Number(exactTitleKey(entryTitle(y)) === exactTitleKey(name)) - Number(exactTitleKey(entryTitle(x)) === exactTitleKey(name))
    || listed(y) - listed(x) || x.position - y.position)[0];
  const drops = members.filter((t) => t.id !== keep.id);
  const cs = new ChangeSet(database, actor, summary('作品 {release}：{n} 个曲目条目合并为「{title}」', { release: label(release), n: members.length, title: name }));
  // A row that showed a merged entry's title keeps it, as its own 标题 tag.
  for (const r of rows.filter((x) => x.track_id !== keep.id)) {
    const drop = drops.find((t) => t.id === r.track_id)!;
    const tags = parseTags(r.tags);
    const shown = entryTitle(drop);
    const next = 'title' in tags || exactTitleKey(shown) === exactTitleKey(name) ? r.tags : JSON.stringify({ ...tags, title: [shown] });
    cs.updateKnown('edition_track', { id: r.id }, r as unknown as Record<string, unknown>, { track_id: keep.id, tags: next });
  }
  cs.updateFilesWhere('track_id IN (SELECT value FROM json_each(?))', [JSON.stringify(drops.map((t) => t.id))], { track_id: keep.id });
  // The kept entry's song is the merged entries' song too; it takes the chosen title when it was named after them.
  let songId = keep.song_id;
  const songs = [...new Set(drops.map((t) => t.song_id).filter((x): x is string => !!x && x !== keep.song_id))];
  if (!songId && songs.length) songId = songs.shift()!;
  const moved: string[] = []; // other releases' tracks of the merged entries' songs, now of the kept one
  if (songId && songs.length) {
    const { results: others } = await database
      .prepare('SELECT id, song_id FROM tracks WHERE song_id IN (SELECT value FROM json_each(?1)) AND id NOT IN (SELECT value FROM json_each(?2))')
      .bind(JSON.stringify(songs), JSON.stringify(drops.map((t) => t.id)))
      .all<{ id: string; song_id: string }>();
    for (const t of others) {
      cs.updateKnown('track', { id: t.id }, t, { song_id: songId });
      moved.push(t.id);
    }
  }
  cs.updateKnown('track', { id: keep.id }, keep as unknown as Record<string, unknown>, { title: name, song_id: songId });
  if (songId) {
    const song = await database.prepare('SELECT id, title, note FROM songs WHERE id = ?').bind(songId).first<{ id: string; title: string; note: string | null }>();
    if (song && !song.note && members.some((t) => exactTitleKey(t.title) === exactTitleKey(song.title))) {
      cs.updateKnown('song', { id: song.id }, song, { title: name });
    }
  }
  for (const t of drops) await cs.delete('track', { id: t.id });
  await dropSongs(cs, songs, [...drops.map((t) => t.id), ...moved]);
  return cs.commit();
}

/** The edition played by default on the public page: the chosen one, else the newest with the most tracks. */
export function defaultEdition(editions: EditionRow[], trackCounts: Map<string, number>): EditionRow | null {
  const chosen = editions.find((e) => e.is_default);
  if (chosen) return chosen;
  const audio = editions.filter((e) => (trackCounts.get(e.id) ?? 0) > 0 && e.slot !== 'pv' && e.slot !== 'scans');
  return audio.sort((a, b) => (trackCounts.get(b.id) ?? 0) - (trackCounts.get(a.id) ?? 0)
    || (b.release_date ?? '').localeCompare(a.release_date ?? ''))[0] ?? null;
}
