// Songs: one piece of music across releases (an album track, its single version, a remix, a DEMO).
// Merging moves every track of the merged songs to the one kept and deletes the others.

import { ChangeSet } from './changes';
import { db } from './db';
import { newId, titleKey } from './tracks';
import { N_, summary, UserError } from './i18n';

export interface SongVersion {
  track_id: string;
  song_id: string;
  release_id: string;
  catalog_no: string | null;
  release_title: string;
  release_date: string | null;
  disc: number;
  position: number;
  title: string;
  version_label: string | null;
  duration_ms: number | null;
}

export async function versionsOf(songIds: string[]): Promise<SongVersion[]> {
  if (songIds.length === 0) return [];
  const { results } = await db()
    .prepare(
      `SELECT t.id AS track_id, t.song_id, r.id AS release_id, r.catalog_no, r.title AS release_title, r.release_date,
              t.disc, t.position, t.title, t.version_label, t.duration_ms
       FROM tracks t JOIN releases r ON r.id = t.release_id
       WHERE t.song_id IN (SELECT value FROM json_each(?))
       ORDER BY r.release_date NULLS LAST, r.catalog_no, t.disc, t.position`,
    )
    .bind(JSON.stringify(songIds))
    .all<SongVersion>();
  return results;
}

export interface SongSummary {
  id: string;
  title: string;
  n: number;
}

/**
 * Groups of songs that may be the same piece: same title (ignoring width, case, punctuation and
 * bracketed notes), tracks whose files decode to identical audio, or tracks whose files sound like the
 * same recording (acoustic fingerprints).
 */
export async function mergeCandidates(): Promise<{ songs: SongSummary[]; reasons: string[] }[]> {
  const database = db();
  const [{ results: songs }, { results: sameAudio }, { results: sameRecording }] = await Promise.all([
    database
      .prepare('SELECT s.id, s.title, count(t.id) AS n FROM songs s LEFT JOIN tracks t ON t.song_id = s.id GROUP BY s.id')
      .all<SongSummary>(),
    database
      .prepare(
        `SELECT DISTINCT t1.song_id AS a, t2.song_id AS b
         FROM files f1 JOIN files f2 ON f2.pcm_md5 = f1.pcm_md5 AND f2.id != f1.id
         JOIN tracks t1 ON t1.id = f1.track_id JOIN tracks t2 ON t2.id = f2.track_id
         WHERE f1.pcm_md5 IS NOT NULL AND f1.track_id IS NOT NULL AND f2.track_id IS NOT NULL AND t1.song_id < t2.song_id`,
      )
      .all<{ a: string; b: string }>(),
    // Acoustic fingerprints: files that sound like the same recording (layer 3), linked to tracks.
    database
      .prepare(
        `SELECT DISTINCT t1.song_id AS a, t2.song_id AS b FROM acoustic_matches m
         JOIN files f1 ON f1.sha256 = m.a JOIN files f2 ON f2.sha256 = m.b
         JOIN tracks t1 ON t1.id = f1.track_id JOIN tracks t2 ON t2.id = f2.track_id
         WHERE t1.song_id IS NOT NULL AND t2.song_id IS NOT NULL AND t1.song_id != t2.song_id`,
      )
      .all<{ a: string; b: string }>(),
  ]);
  const byId = new Map(songs.map((s) => [s.id, s]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const reasons = new Map<string, Set<string>>();
  const byKey = new Map<string, string[]>();
  for (const s of songs.filter((s) => s.n > 0)) byKey.set(titleKey(s.title), [...(byKey.get(titleKey(s.title)) ?? []), s.id]);
  const note = (ids: string[], why: string) => {
    for (const id of ids.slice(1)) union(ids[0], id);
    for (const id of ids) reasons.set(id, (reasons.get(id) ?? new Set()).add(why));
  };
  for (const ids of byKey.values()) if (ids.length > 1) note(ids, N_('同名'));
  for (const { a, b } of sameAudio) if (byId.has(a) && byId.has(b)) note([a, b], N_('音频相同'));
  for (const { a, b } of sameRecording) if (byId.has(a) && byId.has(b)) note([a, b], N_('声学指纹：同一录音'));
  const groups = new Map<string, SongSummary[]>();
  for (const id of reasons.keys()) groups.set(find(id), [...(groups.get(find(id)) ?? []), byId.get(id)!]);
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      songs: g.sort((x, y) => y.n - x.n || x.title.localeCompare(y.title, 'ja')),
      reasons: [...new Set(g.flatMap((s) => [...(reasons.get(s.id) ?? [])]))],
    }))
    .sort((x, y) => x.songs[0].title.localeCompare(y.songs[0].title, 'ja'));
}

/** Move all tracks of the given songs to the target song and delete the merged songs. */
export async function mergeSongs(actor: string, targetId: string, sourceIds: string[]): Promise<number> {
  const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
  if (sources.length === 0) throw new UserError('请至少再选一首要并入的乐曲');
  const database = db();
  const target = await database.prepare('SELECT id, title FROM songs WHERE id = ?').bind(targetId).first<{ id: string; title: string }>();
  if (!target) throw new UserError('找不到要保留的乐曲');
  const { results: tracks } = await database
    .prepare('SELECT id, song_id FROM tracks WHERE song_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(sources))
    .all<{ id: string; song_id: string }>();
  const cs = new ChangeSet(database, actor, summary('乐曲：{n} 首并入「{title}」', { n: sources.length, title: target.title }));
  for (const t of tracks) cs.updateKnown('track', { id: t.id }, t, { song_id: targetId });
  for (const id of sources) {
    if (!(await cs.delete('song', { id }))) throw new UserError('找不到乐曲 {id}', { id });
  }
  return cs.commit();
}

/** Give one track a song of its own (undoes a wrong merge for that track). */
export async function splitTrack(actor: string, trackId: string): Promise<string> {
  const database = db();
  const track = await database.prepare('SELECT id, title, song_id FROM tracks WHERE id = ?').bind(trackId).first<{ id: string; title: string; song_id: string | null }>();
  if (!track) throw new UserError('找不到曲目');
  const songId = newId('s');
  const cs = new ChangeSet(database, actor, summary('乐曲：「{title}」拆成独立乐曲', { title: track.title }));
  cs.create('song', { id: songId, title: track.title, note: null });
  cs.updateKnown('track', { id: track.id }, track, { song_id: songId });
  await cs.commit();
  return songId;
}

export async function saveSong(actor: string, id: string, form: FormData): Promise<number> {
  const title = String(form.get('title') ?? '').trim();
  if (!title) throw new UserError('标题不能为空');
  const cs = new ChangeSet(db(), actor, summary('乐曲：修改「{title}」', { title }));
  await cs.update('song', { id }, { title, note: String(form.get('note') ?? '').trim() || null });
  return cs.commit();
}

/** Delete songs no track belongs to any more (left over after merges or deleted tracks). */
export async function deleteOrphans(actor: string): Promise<number> {
  const database = db();
  const { results } = await database
    .prepare('SELECT id FROM songs s WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.song_id = s.id) LIMIT 250')
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  const cs = new ChangeSet(database, actor, summary('乐曲：删除 {n} 首没有曲目的乐曲', { n: results.length }));
  for (const { id } of results) await cs.delete('song', { id });
  return cs.commit();
}
