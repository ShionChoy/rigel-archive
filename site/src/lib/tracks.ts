// Track lists: editing, generating them from a release's audio files, and linking files to tracks.
// Every track belongs to a song (the same piece across releases); a new track gets a song of its own,
// and the 单曲 page merges songs that turn out to be the same piece.

import { ChangeSet } from './changes';
import { summary, UserError } from './i18n';
import { SLOT_LABELS, isOneOf, SLOTS } from './constants';
import { db, parseFormat, type ReleaseRow, type TrackRow } from './db';
import { newId } from './ids';

export { newId };

/** Title comparison key: width, case, punctuation and bracketed version notes do not matter. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[(（[【<〈『「][^)）\]】>〉』」]*[)）\]】>〉』」]/g, '')
    .replace(/[\s\-‐‑–—~〜～_.,:;!?'"’“”・･·/\\]+/g, '');
}

export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) throw new UserError('时长格式应为 分:秒，例如 4:32：{value}', { value: t });
  const ms = Number((m[4] ?? '0').padEnd(3, '0'));
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

export function formatMs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function label(release: ReleaseRow): string {
  return release.catalog_no ?? release.title;
}

export async function loadTracks(releaseId: string): Promise<TrackRow[]> {
  const { results } = await db()
    .prepare('SELECT * FROM tracks WHERE release_id = ? ORDER BY disc, position, id')
    .bind(releaseId)
    .all<TrackRow>();
  return results;
}

interface EditedTrack {
  id: string | null; // null = new row
  disc: number;
  title: string;
  version_label: string | null;
  duration_ms: number | null;
  song: string; // song id, 'new' for a song of its own, '' to keep
  note: string | null;
}

export function parseTrackForm(form: FormData): { rows: EditedTrack[]; removed: Set<string> } {
  const ids = form.getAll('track_id').map(String);
  const col = (name: string) => form.getAll(name).map((v) => String(v).trim());
  const [discs, titles, versions, durations, songs, notes] = ['disc', 'title', 'version_label', 'duration', 'song', 'track_note'].map(col);
  const removed = new Set(form.getAll('remove').map(String));
  const rows: EditedTrack[] = [];
  ids.forEach((id, i) => {
    if (removed.has(id)) return;
    const title = titles[i] ?? '';
    if (!title) {
      if (id === 'new') return; // an empty added row
      throw new UserError('第 {row} 行：标题不能为空（要删除请勾选「删除」）', { row: i + 1 });
    }
    const disc = Number(discs[i] || 1);
    if (!Number.isInteger(disc) || disc < 1 || disc > 99) throw new UserError('第 {row} 行：碟号应为 1–99', { row: i + 1 });
    if (title.length > 300) throw new UserError('第 {row} 行：标题太长', { row: i + 1 });
    rows.push({
      id: id === 'new' ? null : id, disc, title,
      version_label: versions[i] || null,
      duration_ms: parseDuration(durations[i] ?? ''),
      song: songs[i] ?? '',
      note: notes[i] || null,
    });
  });
  return { rows, removed };
}

/**
 * Save an edited track list. Rows arrive in display order; positions are renumbered per disc from
 * that order. Removed tracks release their files first, so undo can link them again.
 */
export async function saveTracks(actor: string, release: ReleaseRow, current: TrackRow[], form: FormData): Promise<number> {
  const { rows, removed } = parseTrackForm(form);
  const byId = new Map(current.map((t) => [t.id, t]));
  for (const r of rows) if (r.id && !byId.has(r.id)) throw new UserError('曲目表已被别人修改，请刷新后重试');
  const songIds = [...new Set(rows.map((r) => r.song).filter((s) => s && s !== 'new'))];
  if (songIds.length) {
    const { results } = await db()
      .prepare(`SELECT id FROM songs WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(songIds))
      .all<{ id: string }>();
    const known = new Set(results.map((s) => s.id));
    const unknown = songIds.find((s) => !known.has(s));
    if (unknown) throw new UserError('找不到单曲 {id}', { id: unknown });
  }

  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改曲目表', { release: label(release) }));
  const gone = current.filter((t) => removed.has(t.id));
  if (gone.length) {
    const { results: linked } = await db()
      .prepare('SELECT id FROM files WHERE track_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(gone.map((t) => t.id)))
      .all<{ id: string }>();
    cs.updateFiles(linked.map((f) => f.id), { track_id: null });
  }
  const counters = new Map<number, number>();
  for (const r of rows) {
    const position = (counters.get(r.disc) ?? 0) + 1;
    counters.set(r.disc, position);
    let songId: string | null | undefined = r.song && r.song !== 'new' ? r.song : undefined;
    if (r.song === 'new' || (!r.id && !songId)) {
      songId = newId('s');
      cs.create('song', { id: songId, title: r.title, note: null });
    }
    const values = {
      release_id: release.id, disc: r.disc, position, title: r.title, version_label: r.version_label,
      duration_ms: r.duration_ms, note: r.note, ...(songId !== undefined ? { song_id: songId } : {}),
    };
    if (r.id) cs.updateKnown('track', { id: r.id }, byId.get(r.id) as unknown as Record<string, unknown>, values);
    else cs.create('track', { id: newId('t'), credits: null, song_id: null, external_ids: '{}', ...values });
  }
  // The editions' rows for a removed track go with it (recorded, so undo brings them back).
  if (gone.length) {
    const { results: rows } = await db()
      .prepare('SELECT id FROM edition_tracks WHERE track_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(gone.map((t) => t.id)))
      .all<{ id: string }>();
    for (const r of rows) await cs.delete('edition_track', { id: r.id });
  }
  for (const t of gone) await cs.delete('track', { id: t.id });
  return cs.commit();
}

interface AudioFile {
  id: string;
  dir: string;
  name: string;
  slot: string | null;
  track_id: string | null;
  format: string | null;
}

async function audioFiles(releaseId: string, slot?: string): Promise<AudioFile[]> {
  const { results } = await db()
    .prepare(
      `SELECT id, dir, name, slot, track_id, format FROM files f
       WHERE release_id = ? AND kind = 'audio' AND state != 'ignored' AND dup_of IS NULL
         AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id) ${slot ? 'AND slot = ?' : ''}
       ORDER BY dir, name`,
    )
    .bind(...(slot ? [releaseId, slot] : [releaseId]))
    .all<AudioFile>();
  return results;
}

/** Disc and track number of an audio file, from its tags, else from its name and folder. */
export function trackNumber(file: { dir: string; name: string; format: string | null }): { disc: number; track: number | null } {
  const tags = parseFormat(file.format).tags ?? {};
  const num = (v: string | undefined) => {
    const n = parseInt((v ?? '').split('/')[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const folderDisc = file.dir.match(/(?:disc|disk|cd)[\s_-]*(\d{1,2})\b/i);
  const disc = num(tags.disc) ?? (folderDisc ? Number(folderDisc[1]) : null) ?? 1;
  const lead = file.name.match(/^(?:(\d)[-.](?=\d))?(\d{1,3})(?=[\s._\-)]|$)/);
  const track = num(tags.track) ?? (lead ? Number(lead[2]) : null);
  return { disc: lead?.[1] && !tags.disc ? Number(lead[1]) : disc, track };
}

/** A readable track title from tags or the file name ("01 Riddika.flac" → "Riddika"). */
export function titleFromFile(file: { name: string; format: string | null }): string {
  // Some shops put the number into the title tag too («1. Lengsel»).
  const tag = parseFormat(file.format).tags?.title?.trim().replace(/^\d{1,3}\s*[.．)）]\s+/, '');
  if (tag) return tag;
  const stem = file.name.replace(/\.[^.]+$/, '');
  // «Rigel Theatre - Phantom Swing.wav»: the circle's name in front is not part of the title.
  const title = stem.replace(/^Rig[eë]l Theatre\s+-\s+/i, '');
  return title.replace(/^(?:\d[-.])?\d{1,3}\s*[-._)\]]*\s*/, '').trim() || title;
}

/** Build the track list from the audio files of one slot (only while the release has no tracks). */
export async function generateTracks(actor: string, release: ReleaseRow, slotRaw: string): Promise<number> {
  if (!isOneOf(SLOTS, slotRaw)) throw new UserError('请选择从哪个栏位的文件生成');
  if ((await loadTracks(release.id)).length) throw new UserError('已经有曲目表了；要重新生成，先删除现有曲目');
  const files = await audioFiles(release.id, slotRaw);
  if (files.length === 0) throw new UserError('「{slot}」栏位里没有音频文件', { slot: SLOT_LABELS[slotRaw] });
  const ordered = files
    .map((f) => ({ f, n: trackNumber(f) }))
    .sort((a, b) => a.n.disc - b.n.disc || (a.n.track ?? 999) - (b.n.track ?? 999) || a.f.name.localeCompare(b.f.name, 'ja'));
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：从「{slot}」的 {n} 个文件生成曲目表', { release: label(release), slot: SLOT_LABELS[slotRaw], n: files.length }));
  const counters = new Map<number, number>();
  for (const { f, n } of ordered) {
    const position = (counters.get(n.disc) ?? 0) + 1;
    counters.set(n.disc, position);
    const title = titleFromFile(f);
    const songId = newId('s');
    const trackId = newId('t');
    const seconds = parseFormat(f.format).duration;
    cs.create('song', { id: songId, title, note: null });
    cs.create('track', {
      id: trackId, release_id: release.id, disc: n.disc, position, title, song_id: songId, version_label: null,
      duration_ms: seconds ? Math.round(seconds * 1000) : null, credits: null, note: null,
    });
    cs.updateFiles([f.id], { track_id: trackId });
  }
  return cs.commit();
}

/** Link each audio file without a track to the track with its disc and number. Returns the count. */
/**
 * Tracks of this release already heard in unlinked files: a file with the same decoded audio (pcm_md5)
 * or the same recording (acoustic fingerprint, most of the shorter file matching) as a file that is
 * already linked to a track. Only unambiguous answers (one track) are returned.
 */
async function sameRecordingTracks(releaseId: string): Promise<Map<string, string>> {
  const { results } = await db()
    .prepare(
      `SELECT f.id AS file, g.track_id AS track FROM files f
       JOIN files g ON g.pcm_md5 = f.pcm_md5 AND g.release_id = f.release_id AND g.track_id IS NOT NULL
       WHERE f.release_id = ?1 AND f.kind = 'audio' AND f.track_id IS NULL AND f.pcm_md5 IS NOT NULL
       UNION
       SELECT f.id, g.track_id FROM files f
       JOIN acoustic_matches m ON f.sha256 IN (m.a, m.b)
       JOIN fingerprints pa ON pa.sha256 = m.a JOIN fingerprints pb ON pb.sha256 = m.b
       JOIN files g ON g.sha256 = CASE WHEN m.a = f.sha256 THEN m.b ELSE m.a END
         AND g.release_id = f.release_id AND g.track_id IS NOT NULL
       WHERE f.release_id = ?1 AND f.kind = 'audio' AND f.track_id IS NULL
         AND m.matched_ms >= 800 * min(pa.duration, pb.duration)`,
    )
    .bind(releaseId)
    .all<{ file: string; track: string }>();
  const found = new Map<string, Set<string>>();
  for (const r of results) found.set(r.file, (found.get(r.file) ?? new Set()).add(r.track));
  return new Map([...found].filter(([, tracks]) => tracks.size === 1).map(([file, tracks]) => [file, [...tracks][0]]));
}

export async function matchFiles(actor: string, release: ReleaseRow): Promise<{ matched: number; left: number }> {
  const tracks = await loadTracks(release.id);
  if (tracks.length === 0) throw new UserError('还没有曲目表');
  const byNumber = new Map(tracks.map((t) => [`${t.disc}/${t.position}`, t.id]));
  const byTitle = new Map(tracks.map((t) => [titleKey(t.title), t.id]));
  const [files, heard] = await Promise.all([audioFiles(release.id), sameRecordingTracks(release.id)]);
  const groups = new Map<string, string[]>();
  let left = 0;
  for (const f of files.filter((f) => !f.track_id)) {
    const n = trackNumber(f);
    const id = heard.get(f.id) ?? (n.track ? byNumber.get(`${n.disc}/${n.track}`) : undefined) ?? byTitle.get(titleKey(titleFromFile(f)));
    if (!id) {
      left += 1;
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), f.id]);
  }
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：按音频、曲号与标题把文件对应到曲目', { release: label(release) }));
  for (const [trackId, ids] of groups) cs.updateFiles(ids, { track_id: trackId });
  const matched = await cs.commit();
  return { matched, left };
}

/** Save the track chosen for each listed file (the file list on the release page). */
export async function saveFileTracks(actor: string, release: ReleaseRow, form: FormData): Promise<number> {
  const ids = form.getAll('file_id').map(String);
  const chosen = form.getAll('file_track').map(String);
  const tracks = new Set((await loadTracks(release.id)).map((t) => t.id));
  const { results: current } = await db()
    .prepare('SELECT id, track_id FROM files WHERE release_id = ? AND id IN (SELECT value FROM json_each(?))')
    .bind(release.id, JSON.stringify(ids))
    .all<{ id: string; track_id: string | null }>();
  const now = new Map(current.map((f) => [f.id, f.track_id]));
  const groups = new Map<string, string[]>();
  ids.forEach((id, i) => {
    const want = chosen[i] || '';
    if (!now.has(id) || (now.get(id) ?? '') === want) return;
    if (want && !tracks.has(want)) throw new UserError('所选曲目不属于这个作品');
    groups.set(want, [...(groups.get(want) ?? []), id]);
  });
  const cs = new ChangeSet(db(), actor, summary('作品 {release}：修改文件对应的曲目', { release: label(release) }));
  for (const [trackId, list] of groups) cs.updateFiles(list, { track_id: trackId || null });
  return cs.commit();
}

/** Songs with a title like this track's, other than its own, as candidates for linking. */
export async function sameTitleSongs(tracks: TrackRow[]): Promise<Map<string, { id: string; title: string; n: number }[]>> {
  const out = new Map<string, { id: string; title: string; n: number }[]>();
  if (tracks.length === 0) return out;
  const { results } = await db()
    .prepare('SELECT s.id, s.title, count(t.id) AS n FROM songs s LEFT JOIN tracks t ON t.song_id = s.id GROUP BY s.id')
    .all<{ id: string; title: string; n: number }>();
  const byKey = new Map<string, { id: string; title: string; n: number }[]>();
  for (const s of results) byKey.set(titleKey(s.title), [...(byKey.get(titleKey(s.title)) ?? []), s]);
  for (const t of tracks) out.set(t.id, (byKey.get(titleKey(t.title)) ?? []).filter((s) => s.id !== t.song_id));
  return out;
}
