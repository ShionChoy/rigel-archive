// Editions (版本) of a release: each concrete release or source (初版 CD, 第 2 版, Bandcamp, Amazon …)
// with its own track order. The release's tracks (曲目条目) are every track any edition has; an edition's
// disc/position N points at one of them (table edition_tracks). Files filed under an edition are linked
// to the release's tracks (files.track_id), so the same track can be compared across editions.

import { ChangeSet } from './changes';
import { SLOTS, isOneOf, type Slot } from './constants';
import { db, parseFormat, type EditionRow, type EditionStatus, type EditionTrackRow, type ReleaseRow, type TrackRow } from './db';
import { N_, summary, UserError, type T } from './i18n';
import { newId } from './ids';
import { syncSlots } from './releases';
import { loadTracks, parseDuration, titleFromFile, titleKey, trackNumber } from './tracks';

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

const slotIndex = (s: string) => SLOTS.indexOf(s as Slot);

export function sortEditions<E extends Pick<EditionRow, 'slot' | 'sort' | 'release_date' | 'name'>>(list: E[]): E[] {
  return [...list].sort((a, b) => slotIndex(a.slot) - slotIndex(b.slot) || a.sort - b.sort
    || (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999') || a.name.localeCompare(b.name, 'ja'));
}

export async function loadEditions(releaseId: string): Promise<EditionRow[]> {
  const { results } = await db().prepare('SELECT * FROM editions WHERE release_id = ?').bind(releaseId).all<EditionRow>();
  return sortEditions(results);
}

export async function loadEdition(id: string): Promise<EditionRow | null> {
  return db().prepare('SELECT * FROM editions WHERE id = ?').bind(id).first<EditionRow>();
}

function text(form: FormData, name: string, max = 500): string | null {
  const value = String(form.get(name) ?? '').trim();
  if (value.length > max) throw new UserError('内容过长');
  return value === '' ? null : value;
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The editable fields of an edition from its form. */
export function editionPatch(form: FormData, siblings: EditionRow[], self: EditionRow | null): Record<string, unknown> {
  const slot = text(form, 'slot');
  if (!isOneOf(SLOTS, slot)) throw new UserError('请选择版本类型');
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
    album_title: text(form, 'album_title', 300),
    note: text(form, 'note', 2000),
    external_ids: JSON.stringify(ids),
  };
}

function label(release: Pick<ReleaseRow, 'catalog_no' | 'title'>): string {
  return release.catalog_no ?? release.title;
}

export async function createEdition(actor: string, release: ReleaseRow, form: FormData): Promise<string> {
  const siblings = await loadEditions(release.id);
  const patch = editionPatch(form, siblings, null);
  const id = newId('e');
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：新建版本 {edition}', { release: label(release), edition: String(patch.name || patch.slot) }));
  cs.create('edition', { id, release_id: release.id, is_default: 0, cover_file_id: null, sort: siblings.length, ...patch });
  await syncSlots(cs, release.id, [...siblings, patch as { slot: string; status: string }]);
  await cs.commit();
  return id;
}

export async function saveEdition(actor: string, release: ReleaseRow, edition: EditionRow, form: FormData): Promise<number> {
  const siblings = await loadEditions(release.id);
  const patch = editionPatch(form, siblings, edition);
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改版本 {edition}', { release: label(release), edition: edition.name || edition.slot }));
  const isDefault = form.get('is_default') === '1';
  cs.updateKnown('edition', { id: edition.id }, edition as unknown as Record<string, unknown>, { ...patch, is_default: isDefault ? 1 : 0 });
  if (isDefault) {
    for (const e of siblings) if (e.id !== edition.id && e.is_default) cs.updateKnown('edition', { id: e.id }, { is_default: 1 }, { is_default: 0 });
  }
  // Files keep the slot of the edition they are filed under.
  if (patch.slot !== edition.slot) cs.updateFilesWhere('edition_id = ?', [edition.id], { slot: patch.slot });
  await syncSlots(cs, release.id, siblings.map((e) => (e.id === edition.id ? { slot: patch.slot as string, status: patch.status as string } : e)));
  return cs.commit();
}

export async function deleteEdition(actor: string, release: ReleaseRow, edition: EditionRow): Promise<void> {
  const database = db();
  const used = await database
    .prepare('SELECT (SELECT count(*) FROM files WHERE edition_id = ?1) AS files, (SELECT count(*) FROM folders WHERE edition_id = ?1) AS folders')
    .bind(edition.id)
    .first<{ files: number; folders: number }>();
  if (used?.files || used?.folders) throw new UserError('版本里还有文件或文件夹，先移走它们');
  const cs = new ChangeSet(database, actor, summary('作品 {release}：删除版本 {edition}', { release: label(release), edition: edition.name || edition.slot }));
  const { results: rows } = await database.prepare('SELECT id FROM edition_tracks WHERE edition_id = ?').bind(edition.id).all<{ id: string }>();
  for (const r of rows) await cs.delete('edition_track', { id: r.id });
  const { results: children } = await database.prepare('SELECT id FROM editions WHERE based_on = ?').bind(edition.id).all<{ id: string }>();
  for (const c of children) cs.updateKnown('edition', { id: c.id }, { based_on: edition.id }, { based_on: null });
  await cs.delete('edition', { id: edition.id });
  await syncSlots(cs, release.id, (await loadEditions(release.id)).filter((e) => e.id !== edition.id));
  await cs.commit();
}

// ------------------------------------------------------------------------------------------ track order

export interface Credits {
  artist?: string;
  composer?: string;
  lyricist?: string;
  arranger?: string;
}
export const CREDIT_FIELDS = ['artist', 'composer', 'lyricist', 'arranger'] as const;

export function parseCredits(raw: string | null | undefined): Credits {
  try {
    const v = JSON.parse(raw || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(CREDIT_FIELDS.filter((k) => typeof v[k] === 'string' && v[k]).map((k) => [k, v[k]]));
  } catch {
    return {};
  }
}

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

/** The title an edition gives a track: its own, else the track's (with its version label). */
export function trackTitle(et: Pick<EditionTrackView, 'title' | 'entry_title' | 'version_label'>): string {
  if (et.title) return et.title;
  return et.version_label ? `${et.entry_title} (${et.version_label})` : et.entry_title;
}

interface EditedRow {
  id: string | null;
  disc: number;
  title: string | null;
  entry: string; // track id, or 'new'
  duration_ms: number | null;
  credits: Credits;
}

function parseEditionTrackForm(form: FormData): { rows: EditedRow[]; removed: Set<string> } {
  const col = (name: string) => form.getAll(name).map((v) => String(v).trim());
  const ids = col('et_id');
  const [discs, titles, entries, durations] = ['disc', 'title', 'entry', 'duration'].map(col);
  const credits = Object.fromEntries(CREDIT_FIELDS.map((f) => [f, col(f)])) as Record<(typeof CREDIT_FIELDS)[number], string[]>;
  const removed = new Set(form.getAll('remove').map(String));
  const rows: EditedRow[] = [];
  ids.forEach((id, i) => {
    if (removed.has(id)) return;
    const disc = Number(discs[i] || 1);
    if (!Number.isInteger(disc) || disc < 1 || disc > 99) throw new UserError('第 {row} 行：碟号应为 1–99', { row: i + 1 });
    const entry = entries[i] || 'new';
    const title = titles[i] || null;
    if (entry === 'new' && !title) {
      if (id === 'new') return; // an empty added row
      throw new UserError('第 {row} 行：新曲目条目需要标题', { row: i + 1 });
    }
    if (title && title.length > 300) throw new UserError('第 {row} 行：标题太长', { row: i + 1 });
    rows.push({
      id: id === 'new' ? null : id, disc, title, entry,
      duration_ms: parseDuration(durations[i] ?? ''),
      credits: Object.fromEntries(CREDIT_FIELDS.map((f) => [f, (credits[f][i] ?? '').slice(0, 300)]).filter(([, v]) => v)) as Credits,
    });
  });
  return { rows, removed };
}

/**
 * Save an edition's track order and tags. Rows arrive in display order and are numbered per disc. A
 * row's title is kept only where it differs from its track's; credits belong to the track (all editions).
 */
export async function saveEditionTracks(actor: string, release: ReleaseRow, edition: EditionRow, form: FormData): Promise<number> {
  const { rows, removed } = parseEditionTrackForm(form);
  const [current, entries] = await Promise.all([loadEditionTracks(edition.id), loadTracks(release.id)]);
  const byId = new Map(current.map((r) => [r.id, r]));
  const entryById = new Map(entries.map((t) => [t.id, t]));
  for (const r of rows) {
    if (r.id && !byId.has(r.id)) throw new UserError('曲目表已被别人修改，请刷新后重试');
    if (r.entry !== 'new' && !entryById.has(r.entry)) throw new UserError('所选曲目条目不属于这个作品');
  }
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：修改曲目与标签', { edition: `${label(release)} ${edition.name}`.trim() }));
  const counters = new Map<number, number>();
  let nextPosition = entries.reduce((m, t) => Math.max(m, t.position), 0);
  const creditsTouched = new Map<string, Credits>();
  for (const r of rows) {
    const position = (counters.get(r.disc) ?? 0) + 1;
    counters.set(r.disc, position);
    let trackId = r.entry;
    if (trackId === 'new') {
      trackId = newId('t');
      const songId = newId('s');
      nextPosition += 1;
      cs.create('song', { id: songId, title: r.title!, note: null });
      cs.create('track', {
        id: trackId, release_id: release.id, disc: 1, position: nextPosition, title: r.title!, song_id: songId, version_label: null,
        duration_ms: r.duration_ms, credits: null, note: null, external_ids: '{}',
      });
      entryById.set(trackId, { id: trackId, title: r.title! } as TrackRow);
    }
    const entry = entryById.get(trackId)!;
    const title = r.title && r.title !== entry.title ? r.title : null;
    const values = { edition_id: edition.id, disc: r.disc, position, track_id: trackId, title, duration_ms: r.duration_ms };
    if (r.id) cs.updateKnown('edition_track', { id: r.id }, byId.get(r.id) as unknown as Record<string, unknown>, values);
    else cs.create('edition_track', { id: newId('et'), external_ids: '{}', ...values });
    creditsTouched.set(trackId, { ...(creditsTouched.get(trackId) ?? {}), ...r.credits });
    // an emptied credit field is cleared
    for (const f of CREDIT_FIELDS) if (!r.credits[f]) creditsTouched.set(trackId, { ...creditsTouched.get(trackId), [f]: undefined });
  }
  for (const [trackId, credits] of creditsTouched) {
    const entry = entries.find((t) => t.id === trackId);
    if (!entry) continue; // made above with no credits yet
    const next = { ...parseCredits(entry.credits) };
    for (const f of CREDIT_FIELDS) {
      if (credits[f]) next[f] = credits[f];
      else delete next[f];
    }
    const json = Object.keys(next).length ? JSON.stringify(next) : null;
    cs.updateKnown('track', { id: trackId }, entry as unknown as Record<string, unknown>, { credits: json });
  }
  for (const id of removed) if (byId.has(id)) await cs.delete('edition_track', { id });
  return cs.commit();
}

interface EditionAudio {
  id: string;
  dir: string;
  name: string;
  sha256: string | null;
  pcm_md5: string | null;
  track_id: string | null;
  format: string | null;
}

/** The edition's audio files that stand for its tracks (not ignored, not a copy, not an old version). */
export async function editionAudio(editionId: string): Promise<EditionAudio[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, dir, name, sha256, pcm_md5, track_id, format FROM files f
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
 * of the release. Only unambiguous answers (one track) are returned.
 */
async function heardTracks(releaseId: string, files: EditionAudio[]): Promise<Map<string, string>> {
  if (files.length === 0) return new Map();
  const { results } = await db()
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
  return new Map([...found].filter(([, tracks]) => tracks.size === 1).map(([file, tracks]) => [file, [...tracks][0]]));
}

/**
 * Build an edition's track order from its audio files (only while it has none). Files with the same
 * disc and track number (or, without numbers, the same title) are one row: a FLAC and a WAV of the same
 * track. Each row is linked to the release's track it already is (same audio or recording as a linked
 * file, else the same title) or to a new track, and its files are linked to that track. A whole-disc
 * image (over 25 minutes next to at least three other files) is left out.
 */
export async function generateEditionTracks(actor: string, release: ReleaseRow, edition: EditionRow): Promise<number> {
  if ((await loadEditionTracks(edition.id)).length) throw new UserError('这个版本已经有曲目顺序了；要重新生成，先删除现有的行');
  const all = await editionAudio(edition.id);
  const long = (f: EditionAudio) => (parseFormat(f.format).duration ?? 0) > 25 * 60;
  const files = all.length > 3 ? all.filter((f) => !long(f)) : all;
  if (files.length === 0) throw new UserError('这个版本里没有音频文件');
  const [entries, heard] = await Promise.all([loadTracks(release.id), heardTracks(release.id, files)]);
  const known = new Set(entries.map((t) => t.id));
  const byTitle = new Map(entries.map((t) => [titleKey(t.title), t.id]));
  const groups = new Map<string, { disc: number; track: number | null; title: string; files: EditionAudio[] }>();
  const byAudio = new Map<string, string>(); // pcm_md5 → group: a WAV joins the FLAC with the same audio
  // Numbered files first, so an unnumbered copy joins its numbered twin.
  const numbered = [...files].sort((a, b) => Number(!trackNumber(a).track) - Number(!trackNumber(b).track));
  for (const f of numbered) {
    const n = trackNumber(f);
    const title = titleFromFile(f);
    const key = (f.pcm_md5 && byAudio.get(f.pcm_md5)) || (n.track ? `${n.disc}/${n.track}` : `t/${titleKey(title)}`);
    const g = groups.get(key) ?? { disc: n.disc, track: n.track, title, files: [] };
    g.files.push(f);
    groups.set(key, g);
    if (f.pcm_md5 && !byAudio.has(f.pcm_md5)) byAudio.set(f.pcm_md5, key);
  }
  const ordered = [...groups.values()].sort((a, b) => a.disc - b.disc || (a.track ?? 999) - (b.track ?? 999) || a.title.localeCompare(b.title, 'ja'));
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：从 {n} 个文件生成曲目顺序', { edition: `${label(release)} ${edition.name}`.trim(), n: files.length }));
  const counters = new Map<number, number>();
  let nextPosition = entries.reduce((m, t) => Math.max(m, t.position), 0);
  const first = entries.length === 0;
  for (const g of ordered) {
    const position = (counters.get(g.disc) ?? 0) + 1;
    counters.set(g.disc, position);
    // Prefer the tags of a lossless file for the title and length.
    const main = [...g.files].sort((a, b) => Number(!!parseFormat(b.format).lossless) - Number(!!parseFormat(a.format).lossless))[0];
    const title = titleFromFile(main);
    const seconds = parseFormat(main.format).duration;
    let trackId = g.files.map((f) => f.track_id ?? heard.get(f.id)).find((id) => id && known.has(id)) ?? byTitle.get(titleKey(title));
    if (!trackId || !known.has(trackId)) {
      trackId = newId('t');
      const songId = newId('s');
      nextPosition += 1;
      cs.create('song', { id: songId, title, note: null });
      cs.create('track', {
        id: trackId, release_id: release.id, disc: first ? g.disc : 1, position: first ? position : nextPosition, title, song_id: songId,
        version_label: null, duration_ms: seconds ? Math.round(seconds * 1000) : null, credits: null, note: null, external_ids: '{}',
      });
      known.add(trackId);
      byTitle.set(titleKey(title), trackId);
    }
    const entryTitle = entries.find((t) => t.id === trackId)?.title ?? title;
    cs.create('edition_track', {
      id: newId('et'), edition_id: edition.id, disc: g.disc, position, track_id: trackId,
      title: titleKey(entryTitle) === titleKey(title) ? null : title,
      duration_ms: seconds ? Math.round(seconds * 1000) : null, external_ids: '{}',
    });
    const relink = g.files.filter((f) => f.track_id !== trackId).map((f) => f.id);
    if (relink.length) cs.updateFiles(relink, { track_id: trackId });
  }
  return cs.commit();
}

/**
 * Link the edition's audio files that have no track yet: by disc and track number to the edition's
 * rows, else by title, else by a unique length within 2 seconds.
 */
export async function matchEditionFiles(actor: string, release: ReleaseRow, edition: EditionRow): Promise<{ matched: number; left: number }> {
  const [rows, files] = await Promise.all([loadEditionTracks(edition.id), editionAudio(edition.id)]);
  if (rows.length === 0) throw new UserError('这个版本还没有曲目顺序');
  const byNumber = new Map(rows.map((r) => [`${r.disc}/${r.position}`, r.track_id]));
  const byTitle = new Map<string, string>();
  for (const r of rows) {
    byTitle.set(titleKey(trackTitle(r)), r.track_id);
    byTitle.set(titleKey(r.entry_title), r.track_id);
  }
  const groups = new Map<string, string[]>();
  let left = 0;
  for (const f of files.filter((x) => !x.track_id)) {
    const n = trackNumber(f);
    const seconds = parseFormat(f.format).duration ?? 0;
    const byLength = rows.filter((r) => r.duration_ms && Math.abs(r.duration_ms / 1000 - seconds) <= 2);
    const id = (n.track ? byNumber.get(`${n.disc}/${n.track}`) : undefined) ?? byTitle.get(titleKey(titleFromFile(f)))
      ?? (byLength.length === 1 ? byLength[0].track_id : undefined);
    if (!id) {
      left += 1;
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), f.id]);
  }
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：按曲号、标题与时长对应文件', { edition: `${label(release)} ${edition.name}`.trim() }));
  for (const [trackId, ids] of groups) cs.updateFiles(ids, { track_id: trackId });
  const matched = await cs.commit();
  return { matched, left };
}

/** Save the track chosen for each listed file of an edition. */
export async function saveEditionFileTracks(actor: string, release: ReleaseRow, edition: EditionRow, form: FormData): Promise<number> {
  const ids = form.getAll('file_id').map(String);
  const chosen = form.getAll('file_track').map(String);
  const tracks = new Set((await loadTracks(release.id)).map((t) => t.id));
  const { results: current } = await db()
    .prepare('SELECT id, track_id FROM files WHERE edition_id = ? AND id IN (SELECT value FROM json_each(?))')
    .bind(edition.id, JSON.stringify(ids))
    .all<{ id: string; track_id: string | null }>();
  const now = new Map(current.map((f) => [f.id, f.track_id]));
  const groups = new Map<string, string[]>();
  ids.forEach((id, i) => {
    const want = chosen[i] || '';
    if (!now.has(id) || (now.get(id) ?? '') === want) return;
    if (want && !tracks.has(want)) throw new UserError('所选曲目不属于这个作品');
    groups.set(want, [...(groups.get(want) ?? []), id]);
  });
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：修改文件对应的曲目', { edition: `${label(release)} ${edition.name}`.trim() }));
  for (const [trackId, list] of groups) cs.updateFiles(list, { track_id: trackId || null });
  return cs.commit();
}

/** Copy titles and artists from the files' own tags where the edition has none yet. */
export async function importEmbeddedTags(actor: string, release: ReleaseRow, edition: EditionRow): Promise<number> {
  const [rows, files, entries] = await Promise.all([loadEditionTracks(edition.id), editionAudio(edition.id), loadTracks(release.id)]);
  const fileOf = new Map(files.filter((f) => f.track_id).map((f) => [f.track_id!, f]));
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：从文件标签导入', { edition: `${label(release)} ${edition.name}`.trim() }));
  for (const r of rows) {
    const f = fileOf.get(r.track_id);
    const tags = f ? parseFormat(f.format).tags ?? {} : {};
    if (tags.title && titleKey(tags.title) !== titleKey(trackTitle(r))) {
      cs.updateKnown('edition_track', { id: r.id }, r as unknown as Record<string, unknown>, { title: tags.title === r.entry_title ? null : tags.title });
    }
    const entry = entries.find((t) => t.id === r.track_id);
    const credits = parseCredits(entry?.credits);
    if (entry && tags.artist && !credits.artist) {
      cs.updateKnown('track', { id: entry.id }, entry as unknown as Record<string, unknown>, { credits: JSON.stringify({ ...credits, artist: tags.artist }) });
    }
  }
  return cs.commit();
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

export interface Matrix {
  editions: EditionRow[];
  rows: { track: TrackRow; cells: (Cell | null)[] }[];
  /** Different tracks whose files sound like the same recording: candidates to merge. */
  merges: { a: TrackRow; b: TrackRow; score: number }[];
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

export async function comparison(releaseId: string): Promise<Matrix> {
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
    .filter((e) => rowsOf.has(e.id) || fileRows.results.some((f) => f.edition_id === e.id))
    .sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999') || slotIndex(a.slot) - slotIndex(b.slot) || a.sort - b.sort);

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
    return { track, cells };
  });

  // Different tracks that sound like the same recording (e.g. a track renamed in a later edition).
  const merges: Matrix['merges'] = [];
  const trackOfSha = new Map<string, string>();
  for (const f of fileRows.results) if (f.sha256) trackOfSha.set(f.sha256, f.track_id);
  const seenPairs = new Set<string>();
  for (const [key, m] of matches) {
    const [a, b] = key.split('/');
    const ta = trackOfSha.get(a);
    const tb = trackOfSha.get(b);
    if (!ta || !tb || ta === tb) continue;
    const fa = fileRows.results.find((f) => f.sha256 === a)!;
    const fb = fileRows.results.find((f) => f.sha256 === b)!;
    const c = classify(m.score, m.matched_ms, Math.min(fa.duration ?? 0, fb.duration ?? 0));
    if (c.relation !== 'master') continue;
    // Not when either file is much longer (a full version containing the parts).
    if (Math.max(fa.duration ?? 0, fb.duration ?? 0) > 1.2 * Math.min(fa.duration ?? 0, fb.duration ?? 0)) continue;
    const pair = [ta, tb].sort().join('/');
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const A = tracks.find((t) => t.id === ta);
    const B = tracks.find((t) => t.id === tb);
    if (A && B) merges.push({ a: A, b: B, score: m.score });
  }
  return { editions, rows, merges };
}

/** Merge track `drop` into `keep`: its editions' rows and its files move over, then it is deleted. */
export async function mergeTracks(actor: string, release: ReleaseRow, keepId: string, dropId: string): Promise<number> {
  const tracks = await loadTracks(release.id);
  const keep = tracks.find((t) => t.id === keepId);
  const drop = tracks.find((t) => t.id === dropId);
  if (!keep || !drop || keep.id === drop.id) throw new UserError('请选择这个作品的两个不同曲目条目');
  const database = db();
  const { results: rows } = await database.prepare('SELECT * FROM edition_tracks WHERE track_id = ?').bind(drop.id).all<EditionTrackRow>();
  const cs = new ChangeSet(database, actor, summary('作品 {release}：曲目条目「{drop}」并入「{keep}」', { release: label(release), drop: drop.title, keep: keep.title }));
  for (const r of rows) {
    cs.updateKnown('edition_track', { id: r.id }, r as unknown as Record<string, unknown>, { track_id: keep.id, title: r.title ?? (drop.title !== keep.title ? drop.title : null) });
  }
  cs.updateFilesWhere('track_id = ?', [drop.id], { track_id: keep.id });
  await cs.delete('track', { id: drop.id });
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

export function editionName(e: Pick<EditionRow, 'slot' | 'name'>, t: T, slotLabels: Record<string, string>): string {
  const slot = t(slotLabels[e.slot]);
  return e.name ? `${slot} · ${e.name}` : slot;
}
