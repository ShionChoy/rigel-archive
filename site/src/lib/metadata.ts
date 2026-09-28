// Looking up metadata outside the archive: MusicBrainz (with the Cover Art Archive) and the circle's
// Bandcamp pages; requests go out from the Worker. lib/lookup.ts turns a release into tags and the edition
// page compares them with its tracks.

import type { ReleaseRow } from './db';
import { UserError } from './i18n';
import { titleKey } from './tracks';

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
export async function mbGet<R>(path: string): Promise<R> {
  return mb<R>(path);
}

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

/** A new edition's slot and name for a MusicBrainz release: CDs are rips, the rest digital. */
export function editionFor(c: MbCandidate, all: MbCandidate[]): { slot: string; name: string } {
  const cd = (c.format ?? '').includes('CD');
  if (cd) {
    const cds = all.filter((x) => (x.format ?? '').includes('CD') && x.releaseGroup?.id === c.releaseGroup?.id);
    const second = /2nd|second|第\s*2|再版/i.test(c.disambiguation ?? '') || c.catalogs.some((x) => /\dA$/i.test(x.trim()));
    const first = cds.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0]?.id === c.id;
    return { slot: 'cd_rip', name: second ? '第 2 版' : first && cds.length > 1 ? '初版' : cds.length > 1 ? c.disambiguation ?? c.date ?? '' : '初版' };
  }
  return { slot: 'digital', name: c.disambiguation ?? '' };
}
