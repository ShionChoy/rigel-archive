// The album page's data (作品页): a release's collected editions, and of the chosen one its covers,
// information, tracks (each playing only this edition's own files) and attachments; or 「版本对照」 across the
// editions. components/ReleaseView.astro draws it, on the public site (pages/[lang]/works/[id].astro) and in
// the admin's 预览公开页 (pages/admin/releases/[id]/preview.astro), under the same public rules
// (lib/public/rules.ts); only the addresses differ (the admin's, or the public site's signed ones).
//
// Everything is plain data with its links worked out here (media, downloads), so the page itself only draws.

import { mimeFor } from './constants';
import { COVER_NAME } from './covers';
import { parseFormat, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { comparison, defaultEdition, loadEditions, parseIds, trackTitle } from './editions';
import { embeddedFor, readNow } from './embedded';
import { formatBytes } from './format';
import type { T } from './i18n';
import { loadForms } from './forms';
import { Places } from './locations';
import { imageSrc, pictureSrc, videoSources, type MediaUrls, type Source } from './media';
import { openVersions, playVersions } from './playback';
import { derivedFor } from './processing';
import { accessOf, isListed, isOpen, isPublicEdition, PREVIEW_EDGE, type Access } from './public/rules';
import { clipsFor } from './clips';
import { effectiveTags, parseTags, type Tags } from './tagging/model';
import { parseCover } from './tags';
import { formatMs } from './tracks';

type F = Pick<FileRow, 'id' | 'name' | 'download_name' | 'kind' | 'ext' | 'edition_id' | 'folder_id' | 'track_id' | 'format' | 'size' | 'sha256' | 'blob_key' | 'source_path' | 'member_path' | 'rights'
  | 'pub_visible' | 'pub_play' | 'pub_clip' | 'pub_quality' | 'pub_download'>;
type Row = {
  id: string; disc: number; position: number; track_id: string; tags: string; cover: string | null;
  entry_title: string; version_label: string | null; song_id: string | null; duration_ms: number | null; entry_duration: number | null;
};

export interface NavEdition { id: string; name: string; sub: string; cover: string | null }
export interface Line {
  disc: number; position: number; title: string; sub: string; seconds: number | null; cover: string | null;
  sources: Source[] | null;
  file: string | null; // the file played (the player asks for new addresses by it)
  song: string | null; // the song's page
  /** Only a preview clip is played: the part of the track it is (seconds). */
  clip: [number, number] | null;
  /** A preview clip is wanted but not cut yet. */
  preparing: boolean;
}
export interface Picture { href: string; thumb: string; caption: string }
export interface Video { name: string; poster: string | null; sources: Source[] }
export interface Doc { name: string; size: string; view: string | null; download: string | null; listed: boolean }
export interface Attachments { label: string; pictures: (Picture | { name: string })[]; videos: Video[]; docs: Doc[] }
export interface ChosenView {
  id: string;
  name: string; // «CD 抓轨 · 初版»
  status: EditionRow['status'];
  albumTitle: string;
  subline: string; // catalog · date · tracks · length · formats
  credits: [string, string][];
  description: string | null; // the release's, on its default edition
  descriptionOriginal: boolean; // no translation in the page's language: the original is shown (marked 「原文」)
  note: string | null; // an edition without tracks
  covers: { src: string; n: number }[];
  differentCovers: boolean;
  multiDisc: boolean;
  lines: Line[];
  /** Lines with nothing to play because their audio is here but not open (rights not set, or third-party). */
  withheld: number;
  /** The edition's files the page does not show or play (rights not set; third-party audio). */
  hidden: number;
  withTracks: boolean;
  attachments: Attachments[];
  download: string | null; // null: no download here (the public site's come with accounts, 第 3 阶段)
  /** Some of the edition's files may be downloaded (by members, once accounts come). */
  downloadable: boolean;
  musicbrainz: string | null;
  bandcamp: string | null;
}
export interface ReleaseView {
  release: ReleaseRow & { era_name: string };
  formLabel: string;
  subline: string; // subtitle · years · editions
  /** The release's own pages elsewhere (its 链接): the circle's special page, shops, streaming. */
  pages: { label: string; href: string }[];
  editions: NavEdition[];
  chosen: ChosenView | null;
  compare: Awaited<ReturnType<typeof comparison>> | null;
  compareNames: Map<string, string>;
  /** Files of the chosen edition left out because their rights are not set yet (the preview says so). */
  unsettled: number;
  /** When the page's addresses for sound, video and text run out (unix seconds); null: they do not. */
  expires: number | null;
}

/** Where a view's links go: the public site's pages, or the admin's. */
export interface ViewLinks {
  song(songId: string): string | null;
  /** The whole edition, tagged (null: none here). */
  editionDownload(editionId: string): string | null;
  /** A file that is not read in the page (null: none here). */
  fileDownload(file: { blob_key: string | null; name: string }): string | null;
}

const clock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}` : formatMs(s * 1000));
const readable = (f: F) => ['text', 'playlist'].includes(f.kind) || /^(log|cue|txt|md|nfo)$/i.test(f.ext);

/** How good a file sounds, to play the best of a track's files: lossless first, then bits, rate, bitrate. */
export function audioQuality(format: string | null): number {
  const fmt = parseFormat(format);
  return (fmt.lossless ? 1e6 : 0) + (fmt.bits ?? 0) * 1e3 + (fmt.rate ?? 0) / 1e3 + (fmt.kbps ?? 0) / 1e3;
}

/** A release's 链接 («name URL» lines in the admin, kept as JSON) as the page shows them: known names get their label. */
function releasePages(raw: string, t: T): { label: string; href: string }[] {
  const labels: Record<string, string> = {
    official: t('官方特设页'), bandcamp: 'Bandcamp', booth: 'BOOTH', dlsite: 'DLsite', melonbooks: 'メロンブックス',
    alicebooks: 'アリスブックス', diverse: 'Diverse Direct', youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', apple: 'Apple Music',
  };
  let links: Record<string, unknown> = {};
  try {
    links = JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    // no links
  }
  return Object.entries(links)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && /^https?:\/\//.test(e[1]))
    .map(([key, href]) => ({ label: labels[key] ?? key, href }));
}

/** Which translation of a release's title a reader sees first under the original. */
const SUBTITLE_ORDER: Record<string, string[]> = { ja: ['ja', 'en', 'zh'], en: ['en', 'ja', 'zh'], zh: ['zh', 'en', 'ja'] };

/**
 * The page of a release: `editionId` chooses the edition (else its default), `compare` shows 「版本对照」.
 * `urls` addresses the stored files, `links` the other pages. Null when there is no such release.
 */
export async function loadReleaseView(
  database: D1Database, media: R2Bucket,
  opts: { releaseId: string; editionId: string | null; compare: boolean; t: T; lang: string; urls: MediaUrls & { expires?: number }; links: ViewLinks; readBudgetMs?: number },
): Promise<ReleaseView | null> {
  const { t, urls, links } = opts;
  const release = await database.prepare('SELECT r.*, e.name AS era_name FROM releases r JOIN eras e ON e.id = r.era_id WHERE r.id = ?')
    .bind(opts.releaseId).first<ReleaseRow & { era_name: string }>();
  if (!release) return null;
  const places = await Places.load(database);
  const types = places.types;

  // The editions shown: collected or partly collected ones (missing and to-be-confirmed ones stay in the admin).
  const all = await loadEditions(release.id, types);
  const shown = all.filter(isPublicEdition);
  const editionOf = new Map(all.map((e) => [e.id, e]));
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
        `SELECT id, name, download_name, kind, ext, edition_id, folder_id, track_id, format, size, sha256, blob_key, source_path, member_path, rights,
                pub_visible, pub_play, pub_clip, pub_quality, pub_download FROM files f
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
  // What visitors may do with each file (lib/access.ts): files not listed are left out altogether; the rest
  // are listed by name at least.
  const accessCache = new Map<string, Access>();
  const access = (f: F): Access => {
    let a = accessCache.get(f.id);
    if (!a) accessCache.set(f.id, (a = accessOf(f, f.edition_id ? editionOf.get(f.edition_id) : null)));
    return a;
  };
  const listed = (f: F) => isListed(access(f));
  const open = (f: F) => isOpen(access(f));
  /** The pictures a file carries may be shown: listed, and its rights do not hold it back. */
  const showsCover = (f: F) => listed(f) && access(f).ceiling === 'open';
  const unsettled = chosen ? filesResult.results.filter((f) => f.edition_id === chosen.id && f.rights === 'unknown').length : 0;
  const files = filesResult.results.filter(listed);
  const rows = rowsResult.results;
  const mine = chosen ? files.filter((f) => f.edition_id === chosen.id) : [];
  const audio = mine.filter((f) => f.kind === 'audio');
  // What every audio file of the shown editions carries (its tags and pictures), read now where not read yet.
  const shownAudio = files.filter((f) => f.kind === 'audio' && showsCover(f) && shown.some((e) => e.id === f.edition_id));
  await readNow(database, media, shownAudio.map((f) => f.sha256), opts.readBudgetMs ?? 8000).catch(() => 0);
  const [own, derived, clips] = await Promise.all([
    embeddedFor(shownAudio.map((f) => f.sha256), database),
    derivedFor(database, files.map((f) => f.sha256)),
    clipsFor(database, files.filter((f) => f.kind === 'audio' && access(f).play === 'clip').map((f) => f.sha256)),
  ]);
  const derivedOf = (f: F) => (f.sha256 ? derived.get(f.sha256) : undefined);
  const tx = (field: string, code: string) => titles.results.find((x) => x.field === field && x.lang === code)?.value;
  const subtitles = (SUBTITLE_ORDER[opts.lang] ?? SUBTITLE_ORDER.zh).map((code) => tx('title', code)).filter((v): v is string => !!v && v !== release.title);
  const translated = tx('description', opts.lang);
  const description = translated ?? release.description;
  const editionName = (e: EditionRow) => types.editionLabel(e, t);
  // The pictures the tracks carry, by their 640 px previews (one address serves the big cover, the
  // navigation and the rows alike).
  const pictureShas = [...new Set([...[...own.values()].map((e) => e.cover), ...rowsResult.results.map((r) => parseCover(r.cover)?.picture)])]
    .filter((x): x is string => !!x);
  const pictureDerived = await derivedFor(database, pictureShas);
  const picture = (sha256: string) => pictureSrc(sha256, pictureDerived.get(sha256), 640, urls);

  // ---------------------------------------------------------------- covers
  const quality = (f: F) => audioQuality(f.format);
  const versionsOf = (f: F) => playVersions(f, derivedOf(f), access(f), urls, f.sha256 ? clips.get(f.sha256) : undefined);
  const playable = (f: F) => f.kind === 'audio' && open(f) && openVersions(versionsOf(f)).length > 0;
  /** An edition's files for one track, the best-sounding first. */
  const filesOfTrack = (editionId: string, trackId: string) => files.filter((f) => f.edition_id === editionId && f.track_id === trackId && f.kind === 'audio').sort((a, b) => quality(b) - quality(a));
  /** A picture's original, when it may be shown: guests see pictures up to PREVIEW_EDGE (larger ones by their previews). */
  const pictureOriginal = (f: F) => {
    if (!open(f)) return null;
    const fmt = parseFormat(f.format);
    const small = !!fmt.width && !!fmt.height && Math.max(fmt.width, fmt.height) <= PREVIEW_EDGE;
    return small || urls.fullPictures ? urls.original(f, true) : null;
  };
  const imageUrl = (f: F, size: 240 | 640 | 1600) => (open(f) ? imageSrc(pictureOriginal(f), derivedOf(f), size, urls) : null);
  /** The cover a row shows: its chosen one, else the one its (best) file carries. */
  const rowCover = (editionId: string, row: { track_id: string; cover: string | null }): string | null => {
    const c = parseCover(row.cover);
    if (c?.picture) return picture(c.picture);
    if (c?.file) {
      const f = files.find((x) => x.id === c.file);
      return f ? imageUrl(f, 640) : null;
    }
    for (const f of filesOfTrack(editionId, row.track_id).filter(showsCover)) {
      const e = f.sha256 ? own.get(f.sha256) : undefined;
      if (e?.cover) return picture(e.cover);
    }
    return null;
  };
  /** An edition without a track list: its chosen picture, else one named like a cover, else its first picture, else what its audio carries. */
  const editionCover = (e: EditionRow): string | null => {
    const images = files.filter((f) => f.edition_id === e.id && f.kind === 'image' && open(f));
    const chosenFile = e.cover_file_id ? images.find((f) => f.id === e.cover_file_id) : undefined;
    const pick = chosenFile ?? images.find((f) => COVER_NAME.test((f.download_name || f.name).replace(/\.[^.]+$/, ''))) ?? images[0];
    if (pick) return imageUrl(pick, 640);
    for (const f of files.filter((x) => x.edition_id === e.id && x.kind === 'audio' && showsCover(x))) {
      const own1 = f.sha256 ? own.get(f.sha256) : undefined;
      if (own1?.cover) return picture(own1.cover);
    }
    return null;
  };
  // Nav thumbnails: the most used row cover of each edition.
  const { results: navRows } = shown.length
    ? await database.prepare('SELECT edition_id, track_id, cover FROM edition_tracks WHERE edition_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(shown.map((e) => e.id))).all<{ edition_id: string; track_id: string; cover: string | null }>()
    : { results: [] };
  // Covers chosen by hand on other editions' rows: their previews too.
  const more = navRows.map((r) => parseCover(r.cover)?.picture).filter((x): x is string => !!x && !pictureDerived.has(x));
  if (more.length) for (const [sha, d] of await derivedFor(database, more)) pictureDerived.set(sha, d);
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
    pages: releasePages(release.links, t),
    editions: shown.map((e) => ({ id: e.id, name: editionName(e), sub: navSub(e), cover: coversOf(e)[0]?.src ?? null })),
    chosen: null,
    compare: compareView ? await publicComparison(release.id, new Set(shown.map((e) => e.id))) : null,
    compareNames: new Map(shown.map((e) => [e.id, editionName(e)])),
    unsettled,
    expires: urls.expires ?? null,
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
      tags, src: f, cover: e?.cover ? picture(e.cover) : null, seconds: parseFormat(f.format).duration ?? null,
    };
  });
  const raws: Raw[] = rows.length === 0 ? fileLines : rows.map((row) => {
    const list = filesOfTrack(chosen.id, row.track_id);
    const main = list.find(showsCover) ?? list[0];
    const embedded = main?.sha256 ? own.get(main.sha256)?.tags ?? {} : {};
    const tags = effectiveTags(embedded, parseTags(row.tags));
    const src = list.find(playable) ?? null;
    const fmt = main ? parseFormat(main.format) : {};
    return { row, tags, src, cover: rowCover(chosen.id, row), seconds: row.duration_ms ? row.duration_ms / 1000 : fmt.duration ?? (row.entry_duration ? row.entry_duration / 1000 : null) };
  });
  // Tracks whose audio this edition has, but not to play here (its access, or its clip not cut yet).
  const heldBack = new Set(filesResult.results.filter((f) => f.edition_id === chosen.id && f.kind === 'audio' && f.track_id && !playable(f)).map((f) => f.track_id));
  /** A track's file that would be played as a clip once the clip is cut. */
  const clipWanted = (trackId: string) => filesOfTrack(chosen.id, trackId).find((f) => open(f) && access(f).play === 'clip');
  /** The one value the tracks that have the tag agree on (null when none has it or they differ). */
  const common = (name: string): string | null => {
    const values = new Set(raws.map((l) => (l.tags[name] ?? []).join('; ')).filter(Boolean));
    return values.size === 1 ? [...values][0] : null;
  };
  /** Every value the tracks give the tag, each once, in track order: tracks without it (instrumentals for 作词) add nothing. */
  const allValues = (name: string): string | null => {
    const values = new Set(raws.flatMap((l) => l.tags[name] ?? []).map((v) => v.trim()).filter(Boolean));
    return values.size ? [...values].join(' / ') : null;
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
    [t('艺术家'), allValues('albumartist') ?? allValues('artist')],
    [t('作曲'), allValues('composer')],
    [t('作词'), allValues('lyricist')],
    [t('编曲'), allValues('arranger')],
    [t('厂牌'), allValues('label')],
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
    const videos = inGroup.filter((f) => f.kind === 'video' && open(f))
      .map((f) => ({ name: f.download_name || f.name, ...videoSources(urls.original(f, false), derivedOf(f), mimeFor(f.ext), urls) }))
      .filter((v) => v.sources.length > 0);
    return {
      label: groups.length > 1 ? g : '',
      pictures: inGroup.filter((f) => f.kind === 'image').map((f) => {
        const href = imageUrl(f, 1600);
        const fmt = parseFormat(f.format);
        return href
          ? { href, thumb: imageUrl(f, 640) ?? href, caption: `${f.download_name || f.name}${fmt.width ? ` · ${fmt.width}×${fmt.height}` : ''}` }
          : { name: f.download_name || f.name };
      }),
      videos,
      docs: inGroup.filter((f) => f.kind !== 'image' && f.kind !== 'audio' && !videos.some((v) => v.name === (f.download_name || f.name))).map((f) => {
        const listed = !open(f);
        return {
          name: f.download_name || f.name,
          size: listed ? t('只列条目') : formatBytes(f.size),
          view: !listed && readable(f) ? urls.original(f, false) : null,
          download: !listed && !readable(f) && access(f).download ? links.fileDownload(f) : null,
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
    descriptionOriginal: !translated && opts.lang !== 'ja',
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
      sources: l.src ? versionsOf(l.src) : null,
      file: l.src?.id ?? null,
      song: l.row.song_id ? links.song(l.row.song_id) : null,
      clip: l.src && access(l.src).play === 'clip' ? (versionsOf(l.src).find((v) => v.span)?.span ?? null) : null,
      preparing: !l.src && !!l.row.track_id && !!clipWanted(l.row.track_id),
    })),
    withheld: raws.filter((l) => !l.src && heldBack.has(l.row.track_id)).length,
    hidden: filesResult.results.filter((f) => f.edition_id === chosen.id && (!listed(f) || (f.kind === 'audio' && !open(f)))).length,
    withTracks,
    attachments,
    downloadable: mine.some((f) => access(f).download),
    download: mine.some((f) => access(f).download) ? links.editionDownload(chosen.id) : null,
    musicbrainz: ids.musicbrainz_release ? `https://musicbrainz.org/release/${ids.musicbrainz_release}` : null,
    bandcamp: ids.bandcamp ?? null,
  };
  return view;
}

/** 版本对照 among the shown editions only, without the tracks none of them has. */
async function publicComparison(releaseId: string, shown: Set<string>) {
  const matrix = await comparison(releaseId, (e) => shown.has(e.id));
  return { ...matrix, rows: matrix.rows.filter((r) => r.cells.some((c) => c !== null)), merges: [] };
}

export { clock as formatClock };
