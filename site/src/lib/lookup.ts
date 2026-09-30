// 「查找元数据」 on the edition page: candidates from MusicBrainz (and the release's Bandcamp page), and a
// candidate's full data as tags in Picard's names, for the page to compare with the edition's tracks and
// take item by item. Nothing here changes the catalog except storing an online cover (into the
// edition's own folder, as the page's cover dialog would).

import { env } from 'cloudflare:workers';
import { ChangeSet } from './changes';
import { db, type EditionRow, type ReleaseRow } from './db';
import { parseIds } from './editions';
import { summary, UserError } from './i18n';
import { newId } from './ids';
import { Places, ensureEntityFolder, folderKey, freeFileName } from './locations';
import { MBID, MB_UA, bandcampAlbum, mbCandidates, mbGet, scoreCandidate, type MbCandidate } from './metadata';
import type { Tags } from './tagging/model';
import { concat, imageSize } from './tagging/bytes';

export interface OnlineTrack {
  disc: number;
  position: number;
  title: string;
  duration_ms: number | null;
  tags: Tags;
}

/**
 * An online release's front cover: the original as it was uploaded (what 「采用」 stores), a large copy
 * (1200 px, re-encoded by the site; used when the original is too big to take) and a thumbnail.
 */
export interface OnlineCover {
  url: string;
  large: string;
  thumb: string;
  source: 'Cover Art Archive' | 'Bandcamp';
}

export interface OnlineRelease {
  source: 'musicbrainz' | 'bandcamp';
  id: string;
  url: string;
  label: string; // «Title · 2016-10-30 · CD · RTCD-001A»
  cover: OnlineCover | null;
  album: Tags; // the same for every track
  tracks: OnlineTrack[];
}

const caaCover = (release: string): OnlineCover => {
  const base = `https://coverartarchive.org/release/${release}/front`;
  return { url: base, large: `${base}-1200`, thumb: `${base}-250`, source: 'Cover Art Archive' };
};

/** Bandcamp's image sizes: _0 the original (JPEG or PNG), _10 1200 px, _2 350 px. */
const bandcampCover = (image: string | null): OnlineCover | null => {
  const base = image?.replace(/_\d+\.jpg$/, '');
  return base ? { url: `${base}_0.jpg`, large: `${base}_10.jpg`, thumb: `${base}_2.jpg`, source: 'Bandcamp' } : null;
};

export interface Candidate {
  source: 'musicbrainz' | 'bandcamp';
  id: string;
  title: string;
  artist: string | null;
  date: string | null;
  format: string | null;
  tracks: number;
  catalogs: string[];
  country: string | null;
  disambiguation: string | null;
  thumb: string | null;
  score: number;
  url: string;
}

// ------------------------------------------------------------------------------------------ MusicBrainz, in full

interface Artist { id: string; name: string; 'sort-name'?: string }
interface Credit { name: string; joinphrase?: string; artist?: Artist }
interface Rel { type: string; 'target-type'?: string; artist?: Artist; attributes?: string[]; work?: Work }
interface Work { id: string; title: string; relations?: Rel[]; language?: string }
interface Recording { id: string; title: string; length?: number | null; isrcs?: string[]; relations?: Rel[]; 'artist-credit'?: Credit[] }
interface Track { id: string; position: number; title: string; length?: number | null; 'artist-credit'?: Credit[]; recording: Recording }
interface Medium { position: number; format?: string | null; title?: string; 'track-count': number; tracks?: Track[] }
interface Release {
  id: string; title: string; status?: string; country?: string; date?: string; barcode?: string | null; asin?: string | null; disambiguation?: string;
  'text-representation'?: { language?: string | null; script?: string | null };
  'artist-credit'?: Credit[];
  'release-group'?: { id: string; title: string; 'primary-type'?: string | null; 'secondary-types'?: string[]; 'first-release-date'?: string };
  'label-info'?: { 'catalog-number'?: string | null; label?: { id: string; name: string } | null }[];
  media?: Medium[];
  'cover-art-archive'?: { front?: boolean };
}

const names = (c?: Credit[]) => (c?.length ? c.map((x) => x.name + (x.joinphrase ?? '')).join('').trim() : '');
const sortNames = (c?: Credit[]) => (c?.length ? c.map((x) => (x.artist?.['sort-name'] ?? x.name) + (x.joinphrase ?? '')).join('').trim() : '');
const ids = (c?: Credit[]) => [...new Set((c ?? []).map((x) => x.artist?.id).filter((x): x is string => !!x))];

function put(tags: Tags, name: string, ...values: (string | null | undefined)[]) {
  for (const v of values) {
    const s = (v ?? '').trim();
    if (!s) continue;
    const list = tags[name] ?? (tags[name] = []);
    if (!list.includes(s)) list.push(s);
  }
}

/** Relations of a recording and its work, as Picard writes them (composer, lyricist, performers …). */
function relationTags(tags: Tags, rec: Recording) {
  for (const r of rec.relations ?? []) {
    const who = r.artist?.name;
    if (r['target-type'] === 'work' && r.work) {
      put(tags, 'work', r.work.title);
      put(tags, 'musicbrainz_workid', r.work.id);
      for (const w of r.work.relations ?? []) {
        const name = w.artist?.name;
        if (!name) continue;
        if (w.type === 'composer') put(tags, 'composer', name);
        else if (w.type === 'lyricist') put(tags, 'lyricist', name);
        else if (w.type === 'writer') put(tags, 'writer', name);
        else if (w.type === 'arranger' || w.type === 'orchestrator') put(tags, 'arranger', name);
      }
      continue;
    }
    if (!who) continue;
    const attrs = (r.attributes ?? []).filter((a) => !['additional', 'guest', 'solo', 'minor'].includes(a));
    if (r.type === 'instrument') for (const a of attrs.length ? attrs : ['instruments']) put(tags, `performer:${a}`, who);
    else if (r.type === 'vocal') for (const a of attrs.length ? attrs : ['vocals']) put(tags, `performer:${a}`, who);
    else if (r.type === 'performer') put(tags, 'performer:performer', who);
    else if (r.type === 'producer') put(tags, 'producer', who);
    else if (r.type === 'engineer' || r.type === 'recording' || r.type === 'audio') put(tags, 'engineer', who);
    else if (r.type === 'mix') put(tags, 'mixer', who);
    else if (r.type === 'remixer') put(tags, 'remixer', who);
    else if (r.type === 'arranger' || r.type === 'instrument arranger' || r.type === 'vocal arranger' || r.type === 'orchestrator') put(tags, 'arranger', who);
    else if (r.type === 'conductor') put(tags, 'conductor', who);
  }
}

export async function mbFull(id: string): Promise<OnlineRelease> {
  if (!MBID.test(id)) throw new UserError('MusicBrainz 发行 ID 格式不对');
  const r = await mbGet<Release>(`/release/${id}?inc=artists+artist-credits+labels+recordings+release-groups+media+isrcs+artist-rels+recording-rels+recording-level-rels+work-rels+work-level-rels`);
  const album: Tags = {};
  put(album, 'album', r.title);
  put(album, 'albumartist', names(r['artist-credit']));
  put(album, 'albumartistsort', sortNames(r['artist-credit']));
  put(album, 'musicbrainz_albumid', r.id);
  put(album, 'musicbrainz_albumartistid', ...ids(r['artist-credit']));
  const rg = r['release-group'];
  if (rg) {
    put(album, 'musicbrainz_releasegroupid', rg.id);
    put(album, 'releasetype', ...[rg['primary-type'], ...(rg['secondary-types'] ?? [])].map((x) => x?.toLowerCase()));
    put(album, 'originaldate', rg['first-release-date']);
    put(album, 'originalyear', rg['first-release-date']?.slice(0, 4));
  }
  put(album, 'releasestatus', r.status?.toLowerCase());
  put(album, 'releasecountry', r.country);
  put(album, 'date', r.date);
  put(album, 'barcode', r.barcode);
  put(album, 'asin', r.asin);
  put(album, 'script', r['text-representation']?.script);
  put(album, 'language', r['text-representation']?.language);
  for (const l of r['label-info'] ?? []) {
    put(album, 'label', l.label?.name);
    put(album, 'musicbrainz_labelid', l.label?.id);
    put(album, 'catalognumber', l['catalog-number']);
  }
  const media = r.media ?? [];
  put(album, 'media', ...[...new Set(media.map((m) => m.format))]);
  const tracks: OnlineTrack[] = [];
  for (const m of media) {
    for (const t of m.tracks ?? []) {
      const tags: Tags = {};
      put(tags, 'title', t.title);
      const credit = t['artist-credit'] ?? t.recording['artist-credit'];
      put(tags, 'artist', names(credit));
      put(tags, 'artistsort', sortNames(credit));
      put(tags, 'musicbrainz_artistid', ...ids(credit));
      put(tags, 'musicbrainz_recordingid', t.recording.id);
      put(tags, 'musicbrainz_trackid', t.id);
      put(tags, 'isrc', ...(t.recording.isrcs ?? []));
      if (m.title) put(tags, 'discsubtitle', m.title);
      relationTags(tags, t.recording);
      tracks.push({ disc: m.position, position: t.position, title: t.title, duration_ms: t.length ?? t.recording.length ?? null, tags });
    }
  }
  const catalog = album.catalognumber?.[0];
  return {
    source: 'musicbrainz', id: r.id, url: `https://musicbrainz.org/release/${r.id}`,
    label: [r.title, r.date, album.media?.join(' + '), catalog, r.disambiguation].filter(Boolean).join(' · '),
    cover: r['cover-art-archive']?.front ? caaCover(r.id) : null,
    album, tracks,
  };
}

export async function bandcampFull(url: string): Promise<OnlineRelease> {
  const meta = await bandcampAlbum(url);
  const album: Tags = {};
  put(album, 'album', meta.title);
  put(album, 'albumartist', meta.artist);
  put(album, 'date', meta.date);
  put(album, 'website', meta.url);
  put(album, 'media', 'Digital Media');
  return {
    source: 'bandcamp', id: meta.id, url: meta.url, label: [meta.title, meta.date, 'Bandcamp'].filter(Boolean).join(' · '), cover: bandcampCover(meta.cover), album,
    tracks: meta.tracks.map((t) => {
      const tags: Tags = {};
      put(tags, 'title', t.title);
      put(tags, 'artist', t.artist ?? meta.artist);
      return { disc: t.disc, position: t.position, title: t.title, duration_ms: t.duration_ms, tags };
    }),
  };
}

/** A pasted link or id: a MusicBrainz release (id or URL) or a Bandcamp album. */
export async function fetchOnline(ref: string): Promise<OnlineRelease> {
  const s = ref.trim();
  const mb = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
  if (/bandcamp\.com/i.test(s)) return bandcampFull(s);
  if (mb) return mbFull(mb[1].toLowerCase());
  throw new UserError('请贴 MusicBrainz 发行的链接或 ID，或 Bandcamp 专辑链接');
}

// ------------------------------------------------------------------------------------------ candidates

/**
 * Candidates for an edition, best first: MusicBrainz releases found by the edition's catalog number and
 * title (or the admin's own search words), scored by catalog number, track count, lengths and title; the
 * release's Bandcamp page when it has one.
 */
export async function candidates(edition: EditionRow, release: ReleaseRow, query: string | null): Promise<Candidate[]> {
  const database = db();
  const { results } = await database
    .prepare(
      `SELECT et.disc, et.position, max(json_extract(f.format, '$.duration')) AS d FROM edition_tracks et
       LEFT JOIN files f ON f.edition_id = et.edition_id AND f.track_id = et.track_id AND f.kind = 'audio'
       WHERE et.edition_id = ? GROUP BY et.id ORDER BY et.disc, et.position`,
    )
    .bind(edition.id)
    .all<{ d: number | null }>();
  let durations = results.map((r) => (r.d ? r.d * 1000 : null));
  if (durations.length === 0) {
    const { results: files } = await database
      .prepare("SELECT json_extract(format, '$.duration') AS d FROM files WHERE edition_id = ? AND kind = 'audio' AND sealed_in IS NULL ORDER BY name")
      .bind(edition.id)
      .all<{ d: number | null }>();
    durations = files.map((r) => (r.d ? r.d * 1000 : null));
  }
  const mine = { durations, catalog: edition.catalog_no ?? release.catalog_no, title: edition.album_title || release.title };
  let found: (MbCandidate & { artist?: string | null })[];
  if (query && query.trim()) {
    const words = query.trim().replace(/["\\]/g, ' ');
    const data = await mbGet<{ releases?: unknown[] }>(`/release?query=${encodeURIComponent(`${words} OR catno:"${words}"`)}&limit=25`);
    found = (data.releases ?? []).map((r) => mbCandidateOf(r));
  } else found = await mbCandidates(release);
  const out: Candidate[] = found.map((c) => ({
    source: 'musicbrainz', id: c.id, title: c.title, artist: c.artist ?? null, date: c.date, format: c.format, tracks: c.trackCount, catalogs: c.catalogs,
    country: c.country, disambiguation: c.disambiguation, thumb: `https://coverartarchive.org/release/${c.id}/front-250`,
    score: scoreCandidate({ trackCount: c.trackCount, catalogs: c.catalogs, title: c.releaseGroup?.title ?? c.title }, mine), url: `https://musicbrainz.org/release/${c.id}`,
  }));
  // The Bandcamp page the edition or the release names.
  const links = JSON.parse(release.links || '{}') as Record<string, string>;
  const bc = parseIds(edition.external_ids).bandcamp ?? Object.entries(links).find(([k, v]) => /bandcamp/i.test(k + v))?.[1];
  if (bc && !query) {
    try {
      const b = await bandcampFull(bc);
      out.push({
        source: 'bandcamp', id: b.id, title: b.album.album?.[0] ?? '', artist: b.album.albumartist?.[0] ?? null, date: b.album.date?.[0] ?? null,
        format: 'Bandcamp', tracks: b.tracks.length, catalogs: [], country: null, disambiguation: null, thumb: b.cover?.thumb ?? null,
        score: scoreCandidate({ trackCount: b.tracks.length, durations: b.tracks.map((t) => t.duration_ms), catalogs: [], title: b.album.album?.[0] ?? '' }, mine),
        url: b.url,
      });
    } catch {
      // the page is gone or changed: MusicBrainz still gives candidates
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function mbCandidateOf(raw: unknown): MbCandidate & { artist?: string | null } {
  const r = raw as Release & { 'artist-credit'?: Credit[] };
  const catalogs = [...new Set((r['label-info'] ?? []).map((l) => l['catalog-number']).filter((c): c is string => !!c))];
  return {
    id: r.id, title: r.title, date: r.date ?? null, country: r.country ?? null, disambiguation: r.disambiguation || null,
    format: [...new Set((r.media ?? []).map((m) => m.format).filter(Boolean))].join(' + ') || null,
    trackCount: (r.media ?? []).reduce((n, m) => n + (m['track-count'] ?? 0), 0), catalogs,
    releaseGroup: r['release-group'] ? { id: r['release-group'].id, title: r['release-group'].title } : null,
    artist: names(r['artist-credit']) || null,
  };
}

// ------------------------------------------------------------------------------------------ online covers

const COVER_HOSTS = /^https:\/\/(coverartarchive\.org|[a-z0-9-]+\.bcbits\.com|archive\.org|[a-z0-9.-]+\.archive\.org)\//i;
const TAKE_MAX = 30 * 1024 * 1024;

export interface CoverInfo {
  width: number;
  height: number;
  mime: string;
  size: number | null; // bytes of the whole image
}

/** The first `limit` bytes of a response (the rest is not downloaded). */
async function readUpTo(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  while (n < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return concat(parts).subarray(0, limit);
}

/**
 * An online image's size in pixels and bytes, read from its first bytes (a range request; the size in
 * a JPEG can come after a large embedded thumbnail, so up to 2 MB are read when needed).
 */
export async function coverInfo(url: string): Promise<CoverInfo> {
  if (!COVER_HOSTS.test(url)) throw new UserError('只能取回封面库或 Bandcamp 的图片');
  for (const want of [256 * 1024, 2 * 1024 * 1024]) {
    const response = await fetch(url, { headers: { 'user-agent': MB_UA, range: `bytes=0-${want - 1}` } });
    if (!response.ok) throw new UserError('封面读取失败（HTTP {status}）', { status: response.status });
    const total = response.status === 206
      ? Number(/\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1]) || null
      : Number(response.headers.get('content-length')) || null;
    const bytes = await readUpTo(response, want);
    const image = imageSize(bytes);
    if (!image) throw new UserError('在线封面不是 JPEG 或 PNG 图片');
    if (image.width || (total !== null && total <= bytes.length)) return { width: image.width, height: image.height, mime: image.mime, size: total };
  }
  throw new UserError('读不出在线封面的尺寸');
}

/**
 * Fetch an online cover and file it in the edition's own folder (like an upload). Returns the picture file's id.
 * An original over 30 MB is taken as its large copy (`fallback`) instead.
 */
export async function storeOnlineCover(actor: string, edition: EditionRow, release: ReleaseRow, url: string, fallback?: string | null): Promise<string> {
  if (!COVER_HOSTS.test(url) || (fallback && !COVER_HOSTS.test(fallback))) throw new UserError('只能取回封面库或 Bandcamp 的图片');
  let response = await fetch(url, { headers: { 'user-agent': MB_UA } });
  if (!response.ok) throw new UserError('封面下载失败（HTTP {status}）', { status: response.status });
  if (fallback && Number(response.headers.get('content-length')) > TAKE_MAX) {
    await response.body?.cancel();
    response = await fetch(fallback, { headers: { 'user-agent': MB_UA } });
    if (!response.ok) throw new UserError('封面下载失败（HTTP {status}）', { status: response.status });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > TAKE_MAX) throw new UserError('封面太大');
  const size = imageSize(bytes);
  if (!size) throw new UserError('取回的不是 JPEG 或 PNG 图片');
  const ext = size.mime === 'image/png' ? 'png' : 'jpg';
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `blobs/${sha}`;
  if (!(await env.MEDIA.head(key))) await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: size.mime } });
  const database = db();
  const existing = await database.prepare('SELECT id FROM files WHERE sha256 = ? AND edition_id = ?').bind(sha, edition.id).first<{ id: string }>();
  if (existing) return existing.id;
  const source = /coverartarchive|archive\.org/.test(url) ? 'Cover Art Archive' : 'Bandcamp';
  const id = newId('f');
  const cs = new ChangeSet(database, actor, summary('版本 {edition}：取回在线封面（{source}）', { edition: `${release.catalog_no ?? release.title} ${edition.name}`.trim(), source }));
  const places = await Places.load(database);
  const place = places.place(folderKey(ensureEntityFolder(cs, places, `ed:${edition.id}`)));
  const name = await freeFileName(place.folder_id, `cover (${source}).${ext}`);
  cs.createFiles([{
    id, origin: 'upload', source_path: null, dir: '后台上传/封面', member_of: null, member_path: null, name, ext, size: bytes.length,
    mtime: new Date().toISOString(), sha256: sha, blob_key: key, kind: 'image', format: JSON.stringify({ width: size.width, height: size.height }),
    pcm_md5: null, rights: 'own', state: 'classified', release_id: place.release_id, slot: place.slot, track_id: null, role: 'cover', dup_of: null,
    suggest: null, download_name: null, note: `${source}: ${url}`, uploaded_by: actor, checked_at: new Date().toISOString(),
    folder_id: place.folder_id, edition_id: place.edition_id, sealed: 0, sealed_in: null,
  }]);
  await cs.commit();
  return id;
}

// ------------------------------------------------------------------------------------------ importing a whole release

/**
 * 「从 MusicBrainz 导入版本」: an online release into an edition. An edition without a track list gets one
 * (each row with the release's tags, linked to the release's track it already is, by recording or title,
 * else a new one); an edition that has one keeps its order and titles, and its rows whose titles agree
 * get the release's identifiers. The edition records the release, its date, catalog number and track
 * count; the cover, when asked, goes into its folder and onto its rows.
 */
export async function importOnline(actor: string, release: ReleaseRow & { era_name?: string }, edition: EditionRow, online: OnlineRelease, withCover: boolean): Promise<number> {
  const database = db();
  const { results: rows } = await database
    .prepare('SELECT et.id, et.disc, et.position, et.track_id, et.tags, t.title AS entry_title FROM edition_tracks et JOIN tracks t ON t.id = et.track_id WHERE et.edition_id = ?')
    .bind(edition.id)
    .all<{ id: string; disc: number; position: number; track_id: string; tags: string; entry_title: string }>();
  const { results: entries } = await database.prepare('SELECT id, title, position, external_ids FROM tracks WHERE release_id = ?').bind(release.id)
    .all<{ id: string; title: string; position: number; external_ids: string }>();
  const coverId = withCover && online.cover ? await storeOnlineCover(actor, edition, release, online.cover.url, online.cover.large) : null;
  const source = online.source === 'musicbrainz' ? 'MusicBrainz' : 'Bandcamp';
  const cs = new ChangeSet(database, actor, summary('版本 {edition}：采用 {source} 的元数据', { edition: `${release.catalog_no ?? release.title} ${edition.name}`.trim(), source }));
  const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const cover = coverId ? JSON.stringify({ file: coverId, mode: 'replace' }) : null;
  const IDS = ['musicbrainz_recordingid', 'musicbrainz_trackid', 'musicbrainz_albumid', 'musicbrainz_releasegroupid', 'musicbrainz_artistid', 'musicbrainz_albumartistid', 'musicbrainz_workid', 'isrc'];
  if (rows.length === 0) {
    let next = entries.reduce((m, e) => Math.max(m, e.position), 0);
    const taken = new Set<string>();
    for (const x of online.tracks) {
      const recording = x.tags.musicbrainz_recordingid?.[0];
      let entry = entries.find((e) => !taken.has(e.id) && recording && parseIds(e.external_ids).musicbrainz_recording === recording)
        ?? entries.find((e) => !taken.has(e.id) && key(e.title) === key(x.title));
      if (!entry) {
        const id = newId('t');
        const songId = newId('s');
        next += 1;
        cs.create('song', { id: songId, title: x.title, note: null });
        cs.create('track', {
          id, release_id: release.id, disc: 1, position: next, title: x.title, song_id: songId, version_label: null, duration_ms: x.duration_ms,
          credits: null, note: null, external_ids: recording ? JSON.stringify({ musicbrainz_recording: recording }) : '{}',
        });
        entry = { id, title: x.title, position: next, external_ids: '{}' };
      }
      taken.add(entry.id);
      cs.create('edition_track', {
        id: newId('et'), edition_id: edition.id, disc: x.disc, position: x.position, track_id: entry.id, duration_ms: x.duration_ms,
        external_ids: '{}', tags: JSON.stringify({ ...online.album, ...x.tags }), cover,
      });
    }
  } else {
    for (const r of rows) {
      const x = online.tracks.find((o) => o.disc === r.disc && o.position === r.position);
      if (!x) continue;
      const tags = JSON.parse(r.tags || '{}') as Tags;
      const title = tags.title?.[0] ?? r.entry_title;
      const next: Tags = { ...tags };
      if (key(title) === key(x.title)) for (const name of IDS) if (x.tags[name] ?? online.album[name]) next[name] = (x.tags[name] ?? online.album[name])!;
      cs.updateKnown('edition_track', { id: r.id }, { tags: r.tags, cover: null }, { tags: JSON.stringify(next), ...(cover ? { cover } : {}) });
    }
  }
  const ids = { ...parseIds(edition.external_ids) };
  if (online.source === 'musicbrainz') {
    ids.musicbrainz_release = online.id;
    const group = online.album.musicbrainz_releasegroupid?.[0];
    if (group) ids.musicbrainz_release_group = group;
  } else ids.bandcamp = online.url;
  const date = online.album.date?.[0];
  const catalog = online.album.catalognumber?.[0];
  cs.updateKnown('edition', { id: edition.id }, edition as unknown as Record<string, unknown>, {
    external_ids: JSON.stringify(ids), track_count: online.tracks.length,
    ...(date && !edition.release_date ? { release_date: date } : {}), ...(catalog && !edition.catalog_no ? { catalog_no: catalog } : {}),
  });
  return cs.commit();
}
