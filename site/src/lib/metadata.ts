// Looking up metadata outside the archive, Picard-style: MusicBrainz (with the Cover Art Archive) and
// the circle's Bandcamp pages. Both give an AlbumMeta; the admin compares it with an edition field by
// field and takes what is right (applyMeta, one revision batch). Requests go out from the Worker.

import { blobKey } from './api';
import { ChangeSet } from './changes';
import { UPLOAD_ROOT, type Slot } from './constants';
import { db, type EditionRow, type ReleaseRow, type TrackRow } from './db';
import { CREDIT_FIELDS, loadEditionTracks, parseCredits, parseIds, trackTitle, type ExternalIds } from './editions';
import { summary, UserError } from './i18n';
import { newId } from './ids';
import { loadTracks, titleKey } from './tracks';

export interface MetaTrack {
  disc: number;
  position: number;
  title: string;
  duration_ms: number | null;
  artist: string | null;
  recording?: string; // MusicBrainz recording id
  track?: string; // MusicBrainz track id
}

export interface AlbumMeta {
  source: 'musicbrainz' | 'bandcamp';
  id: string; // MusicBrainz release id, or the Bandcamp URL
  url: string; // the page to open
  title: string;
  date: string | null;
  catalog: string | null;
  label: string | null;
  artist: string | null;
  format: string | null;
  disambiguation: string | null;
  releaseGroup: string | null;
  tracks: MetaTrack[];
  cover: string | null; // image URL
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------ MusicBrainz

const MB = 'https://musicbrainz.org/ws/2';
export const MB_UA = 'RigelArchive/1.0 (+https://github.com/ShionChoy/rigel-archive)';
/** Rigël Theatre on MusicBrainz (the other eras have no artist page there). */
export const RIGEL_ARTIST_MBID = 'ed4df00b-77b7-47dd-9735-78a95e5b49f8';
export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let lastCall = 0;

/** MusicBrainz allows one request a second per client. */
async function mb<R>(path: string): Promise<R> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const response = await fetch(`${MB}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
      headers: { 'user-agent': MB_UA, accept: 'application/json' },
    });
    if (response.status === 503 || response.status === 429) {
      await sleep(1500);
      continue;
    }
    if (response.status === 404) throw new UserError('MusicBrainz 上找不到这个条目');
    if (!response.ok) throw new UserError('MusicBrainz 返回错误（HTTP {status}）', { status: response.status });
    return (await response.json()) as R;
  }
  throw new UserError('MusicBrainz 暂时太忙，请稍后再试');
}

interface MbArtistCredit { name: string; joinphrase?: string }
interface MbTrack { id: string; position: number; title: string; length: number | null; recording: { id: string; length?: number | null }; 'artist-credit'?: MbArtistCredit[] }
interface MbMedium { position: number; format?: string | null; 'track-count': number; tracks?: MbTrack[] }
interface MbRelease {
  id: string;
  title: string;
  date?: string;
  country?: string;
  status?: string;
  disambiguation?: string;
  'label-info'?: { 'catalog-number'?: string | null; label?: { name: string } | null }[];
  media?: MbMedium[];
  'release-group'?: { id: string; title: string; 'primary-type'?: string };
  'artist-credit'?: MbArtistCredit[];
  'cover-art-archive'?: { front?: boolean };
}

const credit = (list?: MbArtistCredit[]) => (list?.length ? list.map((c) => c.name + (c.joinphrase ?? '')).join('').trim() : null);

export interface MbCandidate {
  id: string;
  title: string;
  date: string | null;
  country: string | null;
  disambiguation: string | null;
  format: string | null;
  trackCount: number;
  catalogs: string[];
  releaseGroup: { id: string; title: string } | null;
}

function candidate(r: MbRelease): MbCandidate {
  const catalogs = [...new Set((r['label-info'] ?? []).map((l) => l['catalog-number']).filter((c): c is string => !!c))];
  return {
    id: r.id, title: r.title, date: r.date ?? null, country: r.country ?? null, disambiguation: r.disambiguation || null,
    format: [...new Set((r.media ?? []).map((m) => m.format).filter(Boolean))].join(' + ') || null,
    trackCount: (r.media ?? []).reduce((n, m) => n + (m['track-count'] ?? 0), 0),
    catalogs, releaseGroup: r['release-group'] ? { id: r['release-group'].id, title: r['release-group'].title } : null,
  };
}

const quote = (s: string) => `"${s.replace(/["\\]/g, ' ')}"`;

/**
 * Every MusicBrainz release that may be this release: searched by catalog number (with its reissue «A»)
 * and title, then each release group found is listed in full (a search can miss some of its releases).
 */
export async function mbCandidates(release: Pick<ReleaseRow, 'catalog_no' | 'title' | 'era_id'>): Promise<MbCandidate[]> {
  const parts: string[] = [];
  if (release.catalog_no) parts.push(`catno:${quote(release.catalog_no)}`, `catno:${quote(`${release.catalog_no}A`)}`);
  const title = release.title.replace(/\s+/g, ' ').trim();
  parts.push(release.era_id === 'rigel-theatre' ? `(releasegroup:${quote(title)} AND arid:${RIGEL_ARTIST_MBID})` : `releasegroup:${quote(title)}`);
  const found = await mb<{ releases?: MbRelease[] }>(`/release?query=${encodeURIComponent(parts.join(' OR '))}&limit=40`);
  const groups = [...new Set((found.releases ?? []).map((r) => r['release-group']?.id).filter((g): g is string => !!g))].slice(0, 3);
  const out = new Map<string, MbCandidate>();
  for (const r of found.releases ?? []) {
    // Only releases whose catalog number or title fits (the title search is fuzzy).
    const c = candidate(r);
    // Catalog numbers are not unique across labels: a number match needs a similar title as well.
    const a = titleKey(c.releaseGroup?.title ?? c.title);
    const b = titleKey(release.title);
    const similar = a === b || (a.length > 3 && b.includes(a)) || (b.length > 3 && a.includes(b));
    const fits = similar || (release.catalog_no && c.catalogs.some((x) => x.replace(/\s/g, '').toUpperCase().startsWith(release.catalog_no!.toUpperCase()))
      && titleKey(c.title).slice(0, 4) === b.slice(0, 4));
    if (fits) out.set(c.id, c);
  }
  for (const g of groups) {
    if (![...out.values()].some((c) => c.releaseGroup?.id === g)) continue;
    const browse = await mb<{ releases?: MbRelease[] }>(`/release?release-group=${g}&inc=media+labels+release-groups&limit=100`);
    for (const r of browse.releases ?? []) out.set(r.id, candidate(r));
  }
  return [...out.values()].sort((a, b) => (a.releaseGroup?.id ?? '').localeCompare(b.releaseGroup?.id ?? '') || (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}

export async function mbRelease(id: string): Promise<AlbumMeta> {
  if (!MBID.test(id)) throw new UserError('MusicBrainz 发行 ID 格式不对');
  const r = await mb<MbRelease>(`/release/${id}?inc=recordings+artist-credits+labels+release-groups+media`);
  const c = candidate(r);
  const tracks: MetaTrack[] = [];
  for (const m of r.media ?? []) {
    for (const t of m.tracks ?? []) {
      tracks.push({
        disc: m.position, position: t.position, title: t.title, duration_ms: t.length ?? t.recording.length ?? null,
        artist: credit(t['artist-credit']), recording: t.recording.id, track: t.id,
      });
    }
  }
  return {
    source: 'musicbrainz', id: r.id, url: `https://musicbrainz.org/release/${r.id}`, title: r.title, date: r.date ?? null,
    catalog: c.catalogs[0] ?? null, label: (r['label-info'] ?? []).map((l) => l.label?.name).find(Boolean) ?? null,
    artist: credit(r['artist-credit']), format: c.format, disambiguation: c.disambiguation, releaseGroup: c.releaseGroup?.id ?? null,
    tracks, cover: r['cover-art-archive']?.front ? `https://coverartarchive.org/release/${r.id}/front-1200` : null,
  };
}

// ------------------------------------------------------------------------------------------ Bandcamp

const BANDCAMP = /^https:\/\/[a-z0-9-]+\.bandcamp\.com\/(album|track)\/[\w-]+/i;

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|#39);/gi, (_, code: string) => {
    const c = code.toLowerCase();
    if (c === 'quot') return '"';
    if (c === 'amp') return '&';
    if (c === 'lt') return '<';
    if (c === 'gt') return '>';
    if (c === 'apos' || c === '#39') return "'";
    return String.fromCodePoint(c.startsWith('#x') ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10));
  });
}

function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** An album page of the circle's Bandcamp: the track list, date and cover are in its data-tralbum. */
export async function bandcampAlbum(url: string): Promise<AlbumMeta> {
  const clean = url.trim().split(/[?#]/)[0];
  if (!BANDCAMP.test(clean)) throw new UserError('Bandcamp 链接格式不对');
  const response = await fetch(clean, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; RigelArchive/1.0)' } });
  if (!response.ok) throw new UserError('Bandcamp 返回错误（HTTP {status}）', { status: response.status });
  const html = await response.text();
  const m = html.match(/data-tralbum="([^"]+)"/);
  if (!m) throw new UserError('这个页面里没有找到专辑数据');
  const data = JSON.parse(unescapeHtml(m[1])) as {
    artist?: string; art_id?: number; album_release_date?: string;
    current?: { title?: string; release_date?: string };
    trackinfo?: { track_num: number | null; title: string; duration: number }[];
  };
  const tracks = (data.trackinfo ?? []).map((t, i) => ({
    disc: 1, position: t.track_num ?? i + 1, title: t.title, duration_ms: t.duration ? Math.round(t.duration * 1000) : null, artist: null,
  }));
  return {
    source: 'bandcamp', id: clean, url: clean, title: data.current?.title ?? '', date: isoDate(data.album_release_date ?? data.current?.release_date),
    catalog: null, label: null, artist: data.artist ?? null, format: 'Digital Media', disambiguation: null, releaseGroup: null, tracks,
    cover: data.art_id ? `https://f4.bcbits.com/img/a${String(data.art_id).padStart(10, '0')}_10.jpg` : null,
  };
}

// ------------------------------------------------------------------------------------------ scoring

/**
 * How well a candidate fits an edition, 0–1: same number of tracks, lengths within 3 s at the same
 * places, the catalog number, the title.
 */
export function scoreCandidate(
  c: { trackCount: number; durations?: (number | null)[]; catalogs: string[]; title: string },
  e: { durations: (number | null)[]; catalog: string | null; title: string },
): number {
  const n = e.durations.length;
  const count = n && c.trackCount ? Math.max(0, 1 - Math.abs(c.trackCount - n) / Math.max(c.trackCount, n)) : 0;
  let lengths = 0;
  if (c.durations && n) {
    let hits = 0;
    e.durations.forEach((d, i) => {
      const x = c.durations![i];
      if (d && x && Math.abs(d - x) <= 3000) hits += 1;
    });
    lengths = hits / Math.max(n, c.durations.length);
  }
  const catalog = e.catalog && c.catalogs.some((x) => x.replace(/\s/g, '').toUpperCase() === e.catalog!.toUpperCase()) ? 1 : 0;
  const title = titleKey(c.title) === titleKey(e.title) ? 1 : 0;
  return c.durations ? 0.35 * lengths + 0.25 * count + 0.25 * catalog + 0.15 * title : 0.5 * count + 0.35 * catalog + 0.15 * title;
}

// ------------------------------------------------------------------------------------------ applying

export interface MetaChoice {
  fields: Set<'album_title' | 'release_date' | 'catalog_no' | 'track_count'>;
  ids: boolean; // write the source's ids (MusicBrainz release, recordings; the Bandcamp URL)
  /** Take the candidate's titles for rows the edition has. When false, such rows are only matched up
   * (ids, lengths) where the titles agree; rows the edition lacks are still added. */
  titles?: boolean;
  rows: Set<number>; // indexes into meta.tracks to take (titles, lengths, ids)
  artists: boolean; // track artists into the tracks' credits where empty
  cover: boolean;
}

/** Fetch an image and keep it as a file of the edition (like an upload, checked by the processing program). */
async function storeCover(cs: ChangeSet, media: R2Bucket, actor: string, release: ReleaseRow, edition: EditionRow, url: string, source: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': MB_UA } });
  if (!response.ok) throw new UserError('封面下载失败（HTTP {status}）', { status: response.status });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) throw new UserError('封面太大');
  const type = response.headers.get('content-type') ?? '';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = blobKey(sha);
  if (!(await media.head(key))) await media.put(key, bytes, { httpMetadata: { contentType: type || 'image/jpeg' } });
  const existing = await db().prepare('SELECT id FROM files WHERE sha256 = ? AND edition_id = ?').bind(sha, edition.id).first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId('f');
  const name = `${(release.catalog_no ?? release.title).replace(/[\\/:*?"<>|]/g, '_')} ${edition.name || edition.slot} cover (${source}).${ext}`;
  cs.create('file', {
    id, origin: 'upload', dir: `${UPLOAD_ROOT}/封面`, name, ext, size: bytes.length, mtime: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sha256: sha, blob_key: key, kind: 'image', rights: 'own', state: 'classified', release_id: release.id, edition_id: edition.id,
    slot: edition.slot, role: 'cover', note: `${source}: ${url}`, uploaded_by: actor,
  });
  return id;
}

/** Take the chosen parts of a candidate into an edition, its track order and the release's tracks. */
export async function applyMeta(
  actor: string, media: R2Bucket, release: ReleaseRow, edition: EditionRow, meta: AlbumMeta, choice: MetaChoice,
): Promise<number> {
  const source = meta.source === 'musicbrainz' ? 'MusicBrainz' : 'Bandcamp';
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：采用 {source} 的元数据', { edition: `${release.catalog_no ?? release.title} ${edition.name}`.trim(), source }));
  const patch: Record<string, unknown> = {};
  if (choice.fields.has('album_title')) patch.album_title = meta.title && meta.title !== release.title ? meta.title : null;
  if (choice.fields.has('release_date') && meta.date) patch.release_date = meta.date;
  if (choice.fields.has('catalog_no') && meta.catalog) patch.catalog_no = meta.catalog;
  if (choice.fields.has('track_count') && meta.tracks.length) patch.track_count = meta.tracks.length;
  if (choice.ids) {
    const ids: ExternalIds = { ...parseIds(edition.external_ids) };
    if (meta.source === 'musicbrainz') {
      ids.musicbrainz_release = meta.id;
      if (meta.releaseGroup) ids.musicbrainz_release_group = meta.releaseGroup;
    } else ids.bandcamp = meta.id;
    patch.external_ids = JSON.stringify(ids);
  }

  const [rows, entries] = await Promise.all([loadEditionTracks(edition.id), loadTracks(release.id)]);
  const entryOf = new Map(entries.map((t) => [t.id, t]));
  const byRecording = new Map(entries.map((t) => [parseIds(t.external_ids).musicbrainz_recording, t]).filter(([k]) => k) as [string, TrackRow][]);
  const byTitle = new Map(entries.map((t) => [titleKey(t.title), t]));
  const albumArtist = release.artist ?? meta.artist;
  let nextPosition = entries.reduce((m, t) => Math.max(m, t.position), 0);
  const trackIdsUpdates = new Map<string, Record<string, unknown>>();

  for (const [i, m] of meta.tracks.entries()) {
    if (!choice.rows.has(i)) continue;
    const trackIds = choice.ids && m.recording ? { musicbrainz_track: m.track, musicbrainz_recording: m.recording } : {};
    let row = rows.find((r) => r.disc === m.disc && r.position === m.position);
    let entry: TrackRow | undefined = row ? entryOf.get(row.track_id) : (m.recording ? byRecording.get(m.recording) : undefined) ?? byTitle.get(titleKey(m.title));
    if (!row) {
      if (!entry) {
        const id = newId('t');
        const songId = newId('s');
        nextPosition += 1;
        cs.create('song', { id: songId, title: m.title, note: null });
        entry = { id, release_id: release.id, disc: 1, position: nextPosition, title: m.title, song_id: songId, version_label: null, duration_ms: m.duration_ms, credits: null, note: null, external_ids: '{}' };
        cs.create('track', { ...entry });
        entryOf.set(id, entry);
        byTitle.set(titleKey(m.title), entry);
      }
      cs.create('edition_track', {
        id: newId('et'), edition_id: edition.id, disc: m.disc, position: m.position, track_id: entry.id,
        title: m.title === entry.title ? null : m.title, duration_ms: m.duration_ms, external_ids: JSON.stringify(trackIds),
      });
    } else {
      const current = trackTitle(row);
      const agree = titleKey(current) === titleKey(m.title) || titleKey(row.entry_title) === titleKey(m.title);
      if (choice.titles === false && !agree) continue;
      const next: Record<string, unknown> = { duration_ms: m.duration_ms ?? row.duration_ms };
      if (choice.titles !== false && m.title !== current) next.title = m.title === row.entry_title ? null : m.title;
      if (choice.ids && m.recording) next.external_ids = JSON.stringify({ ...parseIds(row.external_ids), ...trackIds });
      cs.updateKnown('edition_track', { id: row.id }, row as unknown as Record<string, unknown>, next);
    }
    if (!entry) continue;
    const update: Record<string, unknown> = {};
    const ids = parseIds(entry.external_ids);
    if (choice.ids && m.recording && !ids.musicbrainz_recording) update.external_ids = JSON.stringify({ ...ids, musicbrainz_recording: m.recording });
    const credits = parseCredits(entry.credits);
    if (choice.artists && m.artist && m.artist !== albumArtist && !credits.artist) {
      update.credits = JSON.stringify(Object.fromEntries(CREDIT_FIELDS.filter((f) => f === 'artist' || credits[f]).map((f) => [f, f === 'artist' ? m.artist : credits[f]])));
    }
    if (Object.keys(update).length) trackIdsUpdates.set(entry.id, { ...(trackIdsUpdates.get(entry.id) ?? {}), ...update });
  }
  for (const [id, update] of trackIdsUpdates) {
    const entry = entryOf.get(id)!;
    if (entries.includes(entry)) cs.updateKnown('track', { id }, entry as unknown as Record<string, unknown>, update);
  }
  if (choice.cover && meta.cover) patch.cover_file_id = await storeCover(cs, media, actor, release, edition, meta.cover, source);
  cs.updateKnown('edition', { id: edition.id }, edition as unknown as Record<string, unknown>, patch);
  return cs.commit();
}

/** A new edition's slot and name for a MusicBrainz release: CDs are rips, the rest digital. */
export function editionFor(c: MbCandidate, all: MbCandidate[]): { slot: Slot; name: string } {
  const cd = (c.format ?? '').includes('CD');
  if (cd) {
    const cds = all.filter((x) => (x.format ?? '').includes('CD') && x.releaseGroup?.id === c.releaseGroup?.id);
    const second = /2nd|second|第\s*2|再版/i.test(c.disambiguation ?? '') || c.catalogs.some((x) => /\dA$/i.test(x.trim()));
    const first = cds.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0]?.id === c.id;
    return { slot: 'cd_rip', name: second ? '第 2 版' : first && cds.length > 1 ? '初版' : cds.length > 1 ? c.disambiguation ?? c.date ?? '' : '初版' };
  }
  return { slot: 'digital', name: c.disambiguation ?? '' };
}
