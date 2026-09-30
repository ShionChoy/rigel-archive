// The public album page's data (公开页): a release's collected editions, and of the chosen one its covers,
// information, tracks (each playing only this edition's own files) and attachments; or 「版本对照」 across the
// editions. components/ReleaseView.astro draws it; the admin's 预览公开页 (pages/admin/releases/[id]/preview)
// shows it today, and the public site will show the same.
//
// Everything is plain data with its links worked out here (media, downloads), so the page itself only draws.

import { mimeFor } from './constants';
import { COVER_NAME } from './covers';
import { parseFormat, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { comparison, defaultEdition, loadEditions, parseIds, trackTitle } from './editions';
import { embeddedFor, pictureUrl, readNow } from './embedded';
import { formatBytes } from './format';
import type { T } from './i18n';
import { loadForms } from './forms';
import { Places } from './locations';
import { audioSources, imageSrc, mediaSrc, type Source } from './media';
import { derivedFor } from './processing';
import { effectiveTags, parseTags, type Tags } from './tagging/model';
import { parseCover } from './tags';
import { formatMs } from './tracks';

type F = Pick<FileRow, 'id' | 'name' | 'download_name' | 'kind' | 'ext' | 'edition_id' | 'folder_id' | 'track_id' | 'format' | 'size' | 'sha256' | 'blob_key' | 'source_path' | 'member_path' | 'rights'>;
type Row = {
  id: string; disc: number; position: number; track_id: string; tags: string; cover: string | null;
  entry_title: string; version_label: string | null; song_id: string | null; duration_ms: number | null; entry_duration: number | null;
};

export interface NavEdition { id: string; name: string; sub: string; cover: string | null }
export interface Line { disc: number; position: number; title: string; sub: string; seconds: number | null; cover: string | null; sources: Source[] | null }
export interface Picture { href: string; thumb: string; caption: string }
export interface Doc { name: string; size: string; view: string | null; download: string | null; listed: boolean }
export interface Attachments { label: string; pictures: (Picture | { name: string })[]; docs: Doc[] }
export interface ChosenView {
  id: string;
  name: string; // «CD 抓轨 · 初版»
  status: EditionRow['status'];
  albumTitle: string;
  subline: string; // catalog · date · tracks · length · formats
  credits: [string, string][];
  description: string | null; // the release's, on its default edition
  note: string | null; // an edition without tracks
  covers: { src: string; n: number }[];
  differentCovers: boolean;
  multiDisc: boolean;
  lines: Line[];
  withTracks: boolean;
  attachments: Attachments[];
  download: string;
  musicbrainz: string | null;
  bandcamp: string | null;
}
export interface ReleaseView {
  release: ReleaseRow & { era_name: string };
  formLabel: string;
  subline: string; // subtitle · years · editions
  editions: NavEdition[];
  chosen: ChosenView | null;
  compare: Awaited<ReturnType<typeof comparison>> | null;
  compareNames: Map<string, string>;
}

const clock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}` : formatMs(s * 1000));
const readable = (f: F) => ['text', 'playlist'].includes(f.kind) || /^(log|cue|txt|md|nfo)$/i.test(f.ext);

/**
 * The page of a release: `editionId` chooses the edition (else its default), `compare` shows 「版本对照」.
 * `base` is MEDIA_DEV_BASE (local development). Null when there is no such release.
 */
export async function loadReleaseView(
  database: D1Database, media: R2Bucket, opts: { releaseId: string; editionId: string | null; compare: boolean; t: T; lang: string; base: string },
): Promise<ReleaseView | null> {
  const { t, base } = opts;
  const release = await database.prepare('SELECT r.*, e.name AS era_name FROM releases r JOIN eras e ON e.id = r.era_id WHERE r.id = ?')
    .bind(opts.releaseId).first<ReleaseRow & { era_name: string }>();
  if (!release) return null;
  const places = await Places.load(database);
  const types = places.types;

  // The editions shown: collected or partly collected ones (missing and to-be-confirmed ones stay in the admin).
  const all = await loadEditions(release.id, types);
  const shown = all.filter((e) => e.status === 'collected' || e.status === 'partial');
  const { results: rowCounts } = await database
    .prepare('SELECT et.edition_id, count(*) AS n FROM edition_tracks et JOIN editions e ON e.id = et.edition_id WHERE e.release_id = ? GROUP BY et.edition_id')
    .bind(release.id)
    .all<{ edition_id: string; n: number }>();
  const trackCounts = new Map(rowCounts.map((r) => [r.edition_id, r.n]));
  const compareView = opts.compare && shown.length > 1;
  const chosen: EditionRow | null = compareView ? null : shown.find((e) => e.id === opts.editionId) ?? defaultEdition(shown, trackCounts) ?? shown[0] ?? null;

  const [filesResult, titles, rowsResult, forms] = await Promise.all([
    database
      .prepare(
        `SELECT id, name, download_name, kind, ext, edition_id, folder_id, track_id, format, size, sha256, blob_key, source_path, member_path, rights FROM files f
         WHERE release_id = ? AND edition_id IS NOT NULL AND state IN ('classified', 'published') AND dup_of IS NULL AND sealed_in IS NULL
           AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)
         ORDER BY coalesce(download_name, name)`,
      )
      .bind(release.id)
      .all<F>(),
    database
      .prepare("SELECT field, lang, value FROM translations WHERE entity = 'release' AND entity_id = ? AND status = 'approved'")
      .bind(release.id)
      .all<{ field: string; lang: string; value: string }>(),
    chosen
      ? database
        .prepare(
          `SELECT et.*, t.title AS entry_title, t.version_label, t.song_id, t.credits, t.duration_ms AS entry_duration, t.external_ids AS entry_ids
           FROM edition_tracks et JOIN tracks t ON t.id = et.track_id WHERE et.edition_id = ? ORDER BY et.disc, et.position`,
        )
        .bind(chosen.id)
        .all<Row>()
      : Promise.resolve({ results: [] as Row[] }),
    loadForms(database),
  ]);
  const files = filesResult.results;
  const rows = rowsResult.results;
  const mine = chosen ? files.filter((f) => f.edition_id === chosen.id) : [];
  const audio = mine.filter((f) => f.kind === 'audio');
  // What every audio file of the shown editions carries (its tags and pictures), read now where not read yet.
  const shownAudio = files.filter((f) => f.kind === 'audio' && shown.some((e) => e.id === f.edition_id));
  await readNow(database, media, shownAudio.map((f) => f.sha256), 8000).catch(() => 0);
  const [own, derived] = await Promise.all([embeddedFor(shownAudio.map((f) => f.sha256), database), derivedFor(database, files.map((f) => f.sha256))]);
  const derivedOf = (f: F) => (f.sha256 ? derived.get(f.sha256) : undefined);
  const tx = (field: string, code: string) => titles.results.find((x) => x.field === field && x.lang === code)?.value;
  const subtitles = (opts.lang === 'ja' ? ['ja', 'en', 'zh'] : ['zh', 'en', 'ja']).map((code) => tx('title', code)).filter((v): v is string => !!v && v !== release.title);
  const description = tx('description', opts.lang) ?? release.description;
  const editionName = (e: EditionRow) => types.editionLabel(e, t);

  // ---------------------------------------------------------------- covers
  const quality = (f: F) => {
    const fmt = parseFormat(f.format);
    return (fmt.lossless ? 1e6 : 0) + (fmt.bits ?? 0) * 1e3 + (fmt.rate ?? 0) / 1e3 + (fmt.kbps ?? 0) / 1e3;
  };
  const playable = (f: F) => f.kind === 'audio' && f.rights !== 'third_party' && mediaSrc(f, base) !== null;
  /** An edition's files for one track, the best-sounding first. */
  const filesOfTrack = (editionId: string, trackId: string) => files.filter((f) => f.edition_id === editionId && f.track_id === trackId && f.kind === 'audio').sort((a, b) => quality(b) - quality(a));
  const imageUrl = (f: F, size: 240 | 640 | 1600) => imageSrc(mediaSrc(f, base), derivedOf(f), size);
  /** The cover a row shows: its chosen one, else the one its (best) file carries. */
  const rowCover = (editionId: string, row: { track_id: string; cover: string | null }): string | null => {
    const c = parseCover(row.cover);
    if (c?.picture) return pictureUrl(c.picture);
    if (c?.file) {
      const f = files.find((x) => x.id === c.file);
      return f ? imageUrl(f, 640) : null;
    }
    for (const f of filesOfTrack(editionId, row.track_id)) {
      const e = f.sha256 ? own.get(f.sha256) : undefined;
      if (e?.cover) return pictureUrl(e.cover);
    }
    return null;
  };
  /** An edition without a track list: its chosen picture, else one named like a cover, else its first picture, else what its audio carries. */
  const editionCover = (e: EditionRow): string | null => {
    const images = files.filter((f) => f.edition_id === e.id && f.kind === 'image');
    const chosenFile = e.cover_file_id ? files.find((f) => f.id === e.cover_file_id) : undefined;
    const pick = chosenFile ?? images.find((f) => COVER_NAME.test((f.download_name || f.name).replace(/\.[^.]+$/, ''))) ?? images[0];
    if (pick) return imageUrl(pick, 640);
    for (const f of files.filter((x) => x.edition_id === e.id && x.kind === 'audio')) {
      const own1 = f.sha256 ? own.get(f.sha256) : undefined;
      if (own1?.cover) return pictureUrl(own1.cover);
    }
    return null;
  };
  // Nav thumbnails: the most used row cover of each edition.
  const { results: navRows } = shown.length
    ? await database.prepare('SELECT edition_id, track_id, cover FROM edition_tracks WHERE edition_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(shown.map((e) => e.id))).all<{ edition_id: string; track_id: string; cover: string | null }>()
    : { results: [] };
  const coversOf = (e: EditionRow): { src: string; n: number }[] => {
    const list = navRows.filter((r) => r.edition_id === e.id);
    if (list.length === 0) {
      const c = editionCover(e);
      return c ? [{ src: c, n: 0 }] : [];
    }
    const counts = new Map<string, number>();
    for (const r of list) {
      const src = rowCover(e.id, r);
      if (src) counts.set(src, (counts.get(src) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([src, n]) => ({ src, n }));
  };
  const navSub = (e: EditionRow) => {
    const n = trackCounts.get(e.id) ?? files.filter((f) => f.edition_id === e.id && f.kind === 'audio').length;
    const pics = files.filter((f) => f.edition_id === e.id && f.kind === 'image').length;
    return [e.catalog_no ?? release.catalog_no, e.release_date, n ? t('{n} 曲', { n }) : pics ? t('{n} 张', { n: pics }) : null].filter(Boolean).join(' · ');
  };
  const years = [...new Set(shown.map((e) => (e.release_date ?? release.release_date ?? '').slice(0, 4)).filter(Boolean))].sort();

  const view: ReleaseView = {
    release,
    formLabel: forms.label(release.form, t),
    subline: [subtitles[0], years.length ? (years.length > 1 ? `${years[0]}–${years.at(-1)}` : years[0]) : release.release_date, shown.length ? t('{n} 个版本', { n: shown.length }) : null].filter(Boolean).join(' · '),
    editions: shown.map((e) => ({ id: e.id, name: editionName(e), sub: navSub(e), cover: coversOf(e)[0]?.src ?? null })),
    chosen: null,
    compare: compareView ? await comparison(release.id) : null,
    compareNames: new Map(shown.map((e) => [e.id, editionName(e)])),
  };
  if (!chosen) return view;

  // ---------------------------------------------------------------- the chosen edition
  interface Raw { row: Row; tags: Tags; src: F | null; cover: string | null; seconds: number | null }
  // An edition with audio but no track list yet plays its files in name order, with the tags they carry.
  const byName = rows.length === 0 ? audio.filter(playable).sort((a, b) => (a.download_name || a.name).localeCompare(b.download_name || b.name, 'ja', { numeric: true })) : [];
  const fileLines: Raw[] = byName.map((f, i) => {
    const e = f.sha256 ? own.get(f.sha256) : undefined;
    const tags: Tags = { ...(e?.tags ?? {}) };
    if (!tags.title?.length) tags.title = [(f.download_name || f.name).replace(/\.[^.]+$/, '')];
    return {
      row: { id: f.id, disc: 1, position: i + 1, track_id: '', tags: '{}', cover: null, entry_title: tags.title[0], version_label: null, song_id: null, duration_ms: null, entry_duration: null },
      tags, src: f, cover: e?.cover ? pictureUrl(e.cover) : null, seconds: parseFormat(f.format).duration ?? null,
    };
  });
  const raws: Raw[] = rows.length === 0 ? fileLines : rows.map((row) => {
    const list = filesOfTrack(chosen.id, row.track_id);
    const main = list[0];
    const embedded = main?.sha256 ? own.get(main.sha256)?.tags ?? {} : {};
    const tags = effectiveTags(embedded, parseTags(row.tags));
    const src = list.find(playable) ?? null;
    const fmt = main ? parseFormat(main.format) : {};
    return { row, tags, src, cover: rowCover(chosen.id, row), seconds: row.duration_ms ? row.duration_ms / 1000 : fmt.duration ?? (row.entry_duration ? row.entry_duration / 1000 : null) };
  });
  const common = (name: string): string | null => {
    const values = raws.map((l) => (l.tags[name] ?? []).join('; '));
    return values.length && values.every((v) => v === values[0]) && values[0] ? values[0] : null;
  };
  const covers = coversOf(chosen);
  const total = raws.reduce((s, l) => s + (l.seconds ?? 0), 0);
  const specs = [...new Set(audio.filter((f) => raws.some((l) => l.src?.id === f.id)).map((f) => {
    const fmt = parseFormat(f.format);
    return fmt.lossless ? `${(f.ext || fmt.codec || '').toUpperCase()} ${fmt.bits ?? '?'} bit / ${+((fmt.rate ?? 0) / 1000).toFixed(1)} kHz` : `${(f.ext || '').toUpperCase()} ${fmt.kbps ?? '?'} kbps`;
  }))];
  const ids = parseIds(chosen.external_ids);
  const withTracks = raws.length > 0;
  const credits = ([
    [t('艺术家'), common('albumartist') ?? common('artist')],
    [t('作曲'), common('composer')],
    [t('作词'), common('lyricist')],
    [t('编曲'), common('arranger')],
    [t('厂牌'), common('label')],
    [t('来源'), chosen.source],
  ] as [string, string | null][]).filter((c): c is [string, string] => !!c[1]);

  // Attachments: the edition's files that are not its tracks, by folder (images as a gallery). The files
  // directly in the edition's folder come first, then each folder below it by its path (as the organizers
  // made them); a single group needs no heading.
  const home = places.editionFolder(chosen.id);
  const folderPath = (folderId: string | null) => {
    if (!folderId || !home || folderId === home.id) return '';
    const chain = places.chain(`fd:${folderId}`);
    return chain.slice(chain.indexOf(`fd:${home.id}`) + 1).map((k) => places.name(k, t)).join(' / ');
  };
  const others = mine.filter((f) => f.kind !== 'audio' || (rows.length > 0 && !raws.some((l) => l.row.track_id === f.track_id)));
  const groups = [...new Set(others.map((f) => folderPath(f.folder_id)))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const attachments: Attachments[] = groups.map((g) => {
    const inGroup = others.filter((f) => folderPath(f.folder_id) === g);
    return {
      label: groups.length > 1 ? g : '',
      pictures: inGroup.filter((f) => f.kind === 'image').map((f) => {
        const src = mediaSrc(f, base);
        const fmt = parseFormat(f.format);
        return src
          ? { href: imageUrl(f, 1600) ?? src, thumb: imageUrl(f, 640) ?? src, caption: `${f.download_name || f.name}${fmt.width ? ` · ${fmt.width}×${fmt.height}` : ''}` }
          : { name: f.name };
      }),
      docs: inGroup.filter((f) => f.kind !== 'image' && f.kind !== 'audio').map((f) => {
        const listed = f.rights === 'third_party';
        const href = f.blob_key ? `/admin/media/${f.blob_key}` : null;
        return {
          name: f.download_name || f.name,
          size: listed ? t('只列条目') : formatBytes(f.size),
          view: !listed && href && readable(f) ? href : null,
          download: !listed && href && !readable(f) ? `${href}?download=${encodeURIComponent(f.download_name || f.name)}` : null,
          listed,
        };
      }),
    };
  });

  view.chosen = {
    id: chosen.id,
    name: editionName(chosen),
    status: chosen.status,
    albumTitle: common('album') ?? chosen.album_title ?? release.title,
    subline: [chosen.catalog_no ?? release.catalog_no, chosen.release_date ?? release.release_date, withTracks ? t('{n} 曲', { n: raws.length }) : null,
      total ? clock(total) : null, specs.join(' / ') || null].filter(Boolean).join(' · '),
    credits,
    description: description && chosen.is_default ? description : null,
    note: !withTracks ? chosen.note : null,
    covers,
    differentCovers: new Set(raws.map((l) => l.cover).filter(Boolean)).size > 1,
    multiDisc: raws.some((l) => l.row.disc > 1),
    lines: raws.map((l) => ({
      disc: l.row.disc,
      position: l.row.position,
      title: l.tags.title?.[0] ?? trackTitle(l.row),
      sub: [(l.tags.artist ?? []).join(' / '), l.tags.composer?.length ? t('作曲 {name}', { name: l.tags.composer.join(' / ') }) : ''].filter(Boolean).join(' · '),
      seconds: l.seconds,
      cover: l.cover,
      sources: l.src ? audioSources(mediaSrc(l.src, base), derivedOf(l.src), mimeFor(l.src.ext)) : null,
    })),
    withTracks,
    attachments,
    download: `/admin/editions/${chosen.id}/zip`,
    musicbrainz: ids.musicbrainz_release ? `https://musicbrainz.org/release/${ids.musicbrainz_release}` : null,
    bandcamp: ids.bandcamp ?? null,
  };
  return view;
}

export { clock as formatClock };
