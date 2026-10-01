// The public site's catalog: what its pages list (首页, 作品库, 乐曲页, the player's /api routes), under
// the public rules (rules.ts), with pictures and sound at the public site's signed addresses (media.ts).
// The album page itself comes from lib/release-view.ts, shared with the admin's preview.

import { editionCovers } from '../covers';
import { parseFormat, type EditionRow, type FileRow, type ReleaseRow } from '../db';
import { sortEditions, trackTitle } from '../editions';
import { embeddedFor } from '../embedded';
import { loadForms } from '../forms';
import type { SiteLang, T } from '../i18n';
import { imageSrc, pictureSrc, type MediaUrls, type Source } from '../media';
import { openVersions, playVersions } from '../playback';
import { derivedFor } from '../processing';
import { accessOf, OPEN_EDITION } from '../access';
import { clipsFor } from '../clips';
import { audioQuality } from '../release-view';
import { effectiveTags, parseTags } from '../tagging/model';
import { parseCover } from '../tags';
import { loadTypes } from '../types';
import { pagesFor } from './paths';
import { OPEN_FILE, PREVIEW_EDGE, PUBLIC_EDITION, PUBLIC_RELEASE } from './rules';

export interface Context {
  t: T;
  lang: SiteLang;
  urls: MediaUrls & { expires: number };
}

// ------------------------------------------------------------------ translations

/** Approved translations of some rows of an entity: `${id}/${field}/${lang}` → text. */
export async function textsFor(database: D1Database, entity: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { results } = await database
    .prepare("SELECT entity_id, field, lang, value FROM translations WHERE entity = ? AND status = 'approved' AND entity_id IN (SELECT value FROM json_each(?))")
    .bind(entity, JSON.stringify([...new Set(ids)]))
    .all<{ entity_id: string; field: string; lang: string; value: string }>();
  for (const r of results) out.set(`${r.entity_id}/${r.field}/${r.lang}`, r.value);
  return out;
}

/** Which translation of a title a reader sees under the original, by the page's language. */
const SUBTITLE_ORDER: Record<SiteLang, SiteLang[]> = { ja: ['ja', 'en', 'zh'], en: ['en', 'ja', 'zh'], zh: ['zh', 'en', 'ja'] };

/** A title's translation to show under the original (none when it only repeats it). */
export function subtitleOf(texts: Map<string, string>, id: string, original: string, lang: SiteLang): string | null {
  for (const code of SUBTITLE_ORDER[lang]) {
    const v = texts.get(`${id}/title/${code}`);
    if (v && v !== original) return v;
  }
  return null;
}

// ------------------------------------------------------------------ eras (名义)

export interface Era { id: string; name: string; years: string | null; description: string | null; works: number }

export async function publicEras(database: D1Database, lang: SiteLang): Promise<Era[]> {
  const { results } = await database
    .prepare(`SELECT e.id, e.name, e.years, (SELECT count(*) FROM releases r WHERE r.era_id = e.id AND ${PUBLIC_RELEASE}) AS works FROM eras e ORDER BY e.sort`)
    .all<{ id: string; name: string; years: string | null; works: number }>();
  const texts = await textsFor(database, 'era', results.map((r) => r.id));
  const text = (id: string, field: string) => texts.get(`${id}/${field}/${lang}`) ?? null;
  return results.map((r) => ({
    id: r.id,
    name: text(r.id, 'name') ?? r.name,
    years: text(r.id, 'years') ?? r.years,
    description: text(r.id, 'description') ?? texts.get(`${r.id}/description/ja`) ?? null,
    works: r.works,
  }));
}

// ------------------------------------------------------------------ works (作品库)

export interface Work {
  id: string;
  title: string;
  subtitle: string | null;
  catalog: string | null;
  date: string | null;
  year: string | null;
  eraId: string;
  era: string;
  formId: string | null;
  form: string;
  series: string | null;
  cover: string | null;
  editions: number;
  tracks: number | null;
}

/** «其他» in the series column means none (the seed catalogue's placeholder). */
const seriesOf = (s: string | null) => (s && !/^(其他|other|なし|-)$/i.test(s.trim()) ? s.trim() : null);

/** Every published release, newest first, with its picture (the first cover of its first collected edition). */
export async function publicWorks(database: D1Database, ctx: Context): Promise<Work[]> {
  const { t, lang, urls } = ctx;
  const [{ results: releases }, { results: editions }, types, forms, eras] = await Promise.all([
    database
      .prepare(`SELECT r.id, r.catalog_no, r.title, r.release_date, r.era_id, r.form, r.series, r.track_count FROM releases r WHERE ${PUBLIC_RELEASE}`)
      .all<Pick<ReleaseRow, 'id' | 'catalog_no' | 'title' | 'release_date' | 'era_id' | 'form' | 'series' | 'track_count'>>(),
    database
      .prepare(`SELECT e.* FROM editions e JOIN releases r ON r.id = e.release_id WHERE ${PUBLIC_RELEASE} AND ${PUBLIC_EDITION}`)
      .all<EditionRow>(),
    loadTypes(database),
    loadForms(database),
    publicEras(database, lang),
  ]);
  const ids = editions.map((e) => e.id);
  const [texts, covers, { results: counts }] = await Promise.all([
    textsFor(database, 'release', releases.map((r) => r.id)),
    editionCovers(ids, { urls, open: true, size: 640 }),
    ids.length
      ? database.prepare('SELECT edition_id, count(*) AS n FROM edition_tracks WHERE edition_id IN (SELECT value FROM json_each(?)) GROUP BY edition_id').bind(JSON.stringify(ids)).all<{ edition_id: string; n: number }>()
      : Promise.resolve({ results: [] as { edition_id: string; n: number }[] }),
  ]);
  const rowsOf = new Map(counts.map((c) => [c.edition_id, c.n]));
  const eraName = new Map(eras.map((e) => [e.id, e.name]));
  const works = releases.map((r): Work => {
    const mine = sortEditions(editions.filter((e) => e.release_id === r.id), types);
    const cover = mine.map((e) => covers.get(e.id)?.[0]?.src).find(Boolean) ?? null;
    const tracks = Math.max(0, ...mine.map((e) => rowsOf.get(e.id) ?? 0)) || r.track_count || null;
    return {
      id: r.id,
      title: r.title,
      subtitle: subtitleOf(texts, r.id, r.title, lang),
      catalog: r.catalog_no,
      date: r.release_date,
      year: r.release_date?.slice(0, 4) ?? null,
      eraId: r.era_id,
      era: eraName.get(r.era_id) ?? r.era_id,
      formId: r.form,
      form: forms.label(r.form, t),
      series: seriesOf(r.series),
      cover,
      editions: mine.length,
      tracks,
    };
  });
  return works.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (a.catalog ?? '~').localeCompare(b.catalog ?? '~') || a.title.localeCompare(b.title));
}

// ------------------------------------------------------------------ tracks (乐曲页, random play)

export interface TrackLine {
  file: string | null;
  title: string;
  sub: string;
  album: string;
  cover: string | null;
  href: string;
  sources: Source[] | null;
  exp: number | null;
  seconds: number | null;
  position: string;
  release: { id: string; title: string; catalog: string | null; date: string | null };
  edition: { id: string; name: string; date: string | null };
}

interface LineRow {
  edition_id: string; track_id: string; tags: string; cover: string | null; disc: number; position: number; duration_ms: number | null;
  entry_title: string; version_label: string | null; entry_duration: number | null;
  slot: string; edition_name: string; edition_date: string | null; edition_catalog: string | null;
  release_id: string; release_title: string; catalog_no: string | null; release_date: string | null;
}
type AudioFile = Pick<FileRow, 'id' | 'edition_id' | 'track_id' | 'format' | 'ext' | 'sha256' | 'blob_key' | 'name' | 'source_path' | 'member_path' | 'rights' | 'kind' | 'size'
  | 'pub_visible' | 'pub_play' | 'pub_clip' | 'pub_quality' | 'pub_download'> & Pick<EditionRow, 'pub_shown'> & {
  e_visible: number; e_play: string; e_clip: string; e_quality: string; e_download: number;
};
/** The columns of a public audio file and its edition's defaults (on files f and editions e). */
const AUDIO_COLUMNS = `f.id, f.edition_id, f.track_id, f.format, f.ext, f.sha256, f.blob_key, f.name, f.source_path, f.member_path, f.rights, f.kind, f.size,
  f.pub_visible, f.pub_play, f.pub_clip, f.pub_quality, f.pub_download,
  e.pub_shown, e.pub_visible AS e_visible, e.pub_play AS e_play, e.pub_clip AS e_clip, e.pub_quality AS e_quality, e.pub_download AS e_download`;
const accessOfAudio = (f: AudioFile) => accessOf(f, {
  ...OPEN_EDITION, pub_shown: f.pub_shown, pub_visible: f.e_visible, pub_play: f.e_play, pub_clip: f.e_clip, pub_quality: f.e_quality, pub_download: f.e_download,
});
/** A public audio file's versions to play (lib/playback.ts). */
async function versionsOf(database: D1Database, files: AudioFile[], urls: MediaUrls): Promise<Map<string, Source[]>> {
  const [derived, clips] = await Promise.all([
    derivedFor(database, files.map((f) => f.sha256)),
    clipsFor(database, files.filter((f) => accessOfAudio(f).play === 'clip').map((f) => f.sha256)),
  ]);
  return new Map(files.map((f) => [f.id, playVersions(f, f.sha256 ? derived.get(f.sha256) : undefined, accessOfAudio(f), urls, f.sha256 ? clips.get(f.sha256) : undefined)]));
}

/** Rows of public editions' track lists matching `where` (on edition_tracks et, editions e, releases r, tracks t). */
async function trackLines(database: D1Database, ctx: Context, where: string, binds: unknown[], tail: string): Promise<TrackLine[]> {
  const { t, lang, urls } = ctx;
  const { results: rows } = await database
    .prepare(
      `SELECT et.edition_id, et.track_id, et.tags, et.cover, et.disc, et.position, et.duration_ms,
              t.title AS entry_title, t.version_label, t.duration_ms AS entry_duration,
              e.slot, e.name AS edition_name, e.release_date AS edition_date, e.catalog_no AS edition_catalog,
              r.id AS release_id, r.title AS release_title, r.catalog_no, r.release_date
       FROM edition_tracks et JOIN editions e ON e.id = et.edition_id JOIN releases r ON r.id = e.release_id JOIN tracks t ON t.id = et.track_id
       WHERE ${PUBLIC_RELEASE} AND ${PUBLIC_EDITION} AND (${where}) ${tail}`,
    )
    .bind(...binds)
    .all<LineRow>();
  if (rows.length === 0) return [];
  const pairs = new Set(rows.map((r) => `${r.edition_id}/${r.track_id}`));
  const { results: found } = await database
    .prepare(
      `SELECT ${AUDIO_COLUMNS} FROM files f JOIN editions e ON e.id = f.edition_id
       WHERE f.kind = 'audio' AND ${OPEN_FILE} AND f.edition_id IN (SELECT value FROM json_each(?)) AND f.track_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify([...new Set(rows.map((r) => r.edition_id))]), JSON.stringify([...new Set(rows.map((r) => r.track_id))]))
    .all<AudioFile>();
  const files = found.filter((f) => pairs.has(`${f.edition_id}/${f.track_id}`));
  const coverFiles = rows.map((r) => parseCover(r.cover)?.file).filter((id): id is string => !!id);
  const { results: coverRows } = coverFiles.length
    ? await database
      .prepare(`SELECT f.id, f.sha256, f.blob_key, f.format FROM files f JOIN editions e ON e.id = f.edition_id WHERE f.id IN (SELECT value FROM json_each(?)) AND f.kind = 'image' AND ${OPEN_FILE}`)
      .bind(JSON.stringify(coverFiles))
      .all<Pick<FileRow, 'id' | 'sha256' | 'blob_key' | 'format'>>()
    : { results: [] };
  const [types, own, versions] = await Promise.all([loadTypes(database), embeddedFor(files.map((f) => f.sha256), database), versionsOf(database, files, urls)]);
  const pictures = [...[...own.values()].map((e) => e.cover), ...rows.map((r) => parseCover(r.cover)?.picture)].filter((x): x is string => !!x);
  const derived = await derivedFor(database, [...files.map((f) => f.sha256), ...coverRows.map((f) => f.sha256), ...pictures]);
  const picture = (sha256: string) => pictureSrc(sha256, derived.get(sha256), 640, urls);
  const pages = pagesFor(lang);
  // The best-sounding file of the track that plays here.
  const best = (r: LineRow) => files
    .filter((f) => f.edition_id === r.edition_id && f.track_id === r.track_id && openVersions(versions.get(f.id)).length > 0)
    .sort((a, b) => audioQuality(b.format) - audioQuality(a.format))[0];
  const pictureOf = (r: LineRow, f: AudioFile | undefined): string | null => {
    const chosen = parseCover(r.cover);
    if (chosen?.picture) return picture(chosen.picture);
    if (chosen?.file) {
      const c = coverRows.find((x) => x.id === chosen.file);
      if (c) {
        const fmt = parseFormat(c.format);
        const small = !!fmt.width && !!fmt.height && Math.max(fmt.width, fmt.height) <= PREVIEW_EDGE;
        return imageSrc(small && c.blob_key ? urls.object(c.blob_key, true) : null, c.sha256 ? derived.get(c.sha256) : undefined, 640, urls);
      }
    }
    const e = f?.sha256 ? own.get(f.sha256) : undefined;
    return e?.cover ? picture(e.cover) : null;
  };
  return rows.map((r) => {
    const f = best(r);
    const embedded = f?.sha256 ? own.get(f.sha256)?.tags ?? {} : {};
    const tags = effectiveTags(embedded, parseTags(r.tags));
    const editionName = types.editionLabel({ slot: r.slot, name: r.edition_name }, t);
    const fmt = f ? parseFormat(f.format) : {};
    const sources = f ? versions.get(f.id) ?? [] : [];
    return {
      file: f?.id ?? null,
      title: tags.title?.[0] ?? trackTitle({ entry_title: r.entry_title, version_label: r.version_label, tags: r.tags }),
      sub: (tags.artist ?? []).join(' / '),
      album: `${r.release_title} · ${editionName}`,
      cover: pictureOf(r, f),
      href: pages.work(r.release_id, r.edition_id),
      sources: openVersions(sources).length ? sources : null,
      exp: urls.expires,
      seconds: r.duration_ms ? r.duration_ms / 1000 : fmt.duration ?? (r.entry_duration ? r.entry_duration / 1000 : null),
      position: r.disc > 1 ? `${r.disc}-${r.position}` : String(r.position),
      release: { id: r.release_id, title: r.release_title, catalog: r.edition_catalog ?? r.catalog_no, date: r.edition_date ?? r.release_date },
      edition: { id: r.edition_id, name: editionName, date: r.edition_date ?? r.release_date },
    };
  });
}

/** A song (乐曲) and every public recording of it, oldest first; null when none is public. */
export async function songPage(database: D1Database, songId: string, ctx: Context) {
  const song = await database.prepare('SELECT id, title, note FROM songs WHERE id = ?').bind(songId).first<{ id: string; title: string; note: string | null }>();
  if (!song) return null;
  const lines = await trackLines(database, ctx, 't.song_id = ?', [song.id], 'ORDER BY coalesce(e.release_date, r.release_date) NULLS LAST, r.catalog_no, e.sort, et.disc, et.position');
  return lines.length ? { song, lines } : null;
}

/** Tracks to play at random (首页 「随机播放」): playable ones only. */
export async function randomQueue(database: D1Database, ctx: Context, n = 20): Promise<TrackLine[]> {
  const lines = await trackLines(
    database, ctx,
    `EXISTS (SELECT 1 FROM files f WHERE f.edition_id = et.edition_id AND f.track_id = et.track_id AND f.kind = 'audio' AND ${OPEN_FILE})`,
    [], `ORDER BY random() LIMIT ${Math.max(1, Math.min(50, n))}`,
  );
  return lines.filter((l) => l.sources);
}

/** How much the site has to listen to: published works and playable tracks. */
export async function publicCounts(database: D1Database): Promise<{ works: number; tracks: number }> {
  const [works, tracks] = await database.batch([
    database.prepare(`SELECT count(*) AS n FROM releases r WHERE ${PUBLIC_RELEASE}`),
    database.prepare(
      `SELECT count(*) AS n FROM edition_tracks et JOIN editions e ON e.id = et.edition_id JOIN releases r ON r.id = e.release_id
       WHERE ${PUBLIC_RELEASE} AND ${PUBLIC_EDITION}
         AND EXISTS (SELECT 1 FROM files f WHERE f.edition_id = et.edition_id AND f.track_id = et.track_id AND f.kind = 'audio' AND ${OPEN_FILE})`,
    ),
  ]);
  return { works: (works.results[0] as { n: number }).n, tracks: (tracks.results[0] as { n: number }).n };
}

// ------------------------------------------------------------------ the player's new addresses

/** Fresh addresses for a public audio file (the player's /api/play); null when it is not public. */
export async function playSources(database: D1Database, fileId: string, urls: MediaUrls & { expires: number }): Promise<{ sources: Source[]; exp: number } | null> {
  const f = await database
    .prepare(
      `SELECT ${AUDIO_COLUMNS}
       FROM files f JOIN editions e ON e.id = f.edition_id JOIN releases r ON r.id = e.release_id
       WHERE f.id = ? AND f.kind = 'audio' AND ${OPEN_FILE} AND ${PUBLIC_EDITION} AND ${PUBLIC_RELEASE}`,
    )
    .bind(fileId)
    .first<AudioFile>();
  if (!f) return null;
  const sources = (await versionsOf(database, [f], urls)).get(f.id) ?? [];
  return openVersions(sources).length ? { sources, exp: urls.expires } : null;
}
