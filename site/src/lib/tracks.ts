// Track lists: editing, generating them from a release's audio files, and linking files to tracks.
// Every track belongs to a song (the same piece across releases); a new track gets a song of its own,
// and the 乐曲 page merges songs that turn out to be the same piece.

import { ChangeSet } from './changes';
import { summary, UserError } from './i18n';
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
    if (unknown) throw new UserError('找不到乐曲 {id}', { id: unknown });
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

/** Disc and track number of an audio file, from its tags, else from its name and folder. */
export function trackNumber(file: { dir: string; name: string; format: string | null }): { disc: number; track: number | null } {
  const tags = parseFormat(file.format).tags ?? {};
  const num = (v: string | undefined) => {
    const n = parseInt((v ?? '').split('/')[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const folderDisc = file.dir.match(/(?:disc|disk|cd)[\s_-]*(\d{1,2})\b/i);
  const disc = num(tags.disc) ?? (folderDisc ? Number(folderDisc[1]) : null) ?? 1;
  const lead = file.name.match(LEAD_NUMBER);
  const shop = lead ? null : BANDCAMP_NAME.exec(file.name.replace(/\.[^.]+$/, ''));
  const track = num(tags.track) ?? (lead ? Number(lead[2]) : shop ? Number(shop[2]) : null);
  return { disc: lead?.[1] && !tags.disc ? Number(lead[1]) : disc, track };
}

/** «01 Title», «1-01 Title»: the number a file name starts with (and the disc before it). */
const LEAD_NUMBER = /^(?:(\d)[-.](?=\d))?(\d{1,3})(?=[\s._\-)]|$)/;
/**
 * Bandcamp names its downloads «Artist - Album - 01 Title»; artists may hold « - » themselves, so the last
 * number set off like this is the track's.
 */
const BANDCAMP_NAME = /^(.+ - .+) - (\d{1,3}) (.+)$/;

/** A readable track title from tags or the file name ("01 Riddika.flac" → "Riddika"). */
export function titleFromFile(file: { name: string; format: string | null }): string {
  // Some shops put the number into the title tag too («1. Lengsel»).
  const tag = parseFormat(file.format).tags?.title?.trim().replace(/^\d{1,3}\s*[.．)）]\s+/, '');
  if (tag) return tag;
  const stem = file.name.replace(/\.[^.]+$/, '');
  const shop = LEAD_NUMBER.test(stem) ? null : BANDCAMP_NAME.exec(stem);
  if (shop?.[3].trim()) return shop[3].trim();
  // «Rigel Theatre - Phantom Swing.wav»: the circle's name in front is not part of the title.
  const title = stem.replace(/^Rig[eë]l Theatre\s+-\s+/i, '');
  return title.replace(/^(?:\d[-.])?\d{1,3}\s*[-._)\]]*\s*/, '').trim() || title;
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
