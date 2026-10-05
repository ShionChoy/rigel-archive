// The cover of an edition as pages show it. Covers go with the tracks: an edition with a track list shows
// its rows' covers (the one chosen for a row on the 版本页, else the one its file carries), the most used
// first, as the public album page does; one without a track list shows what its audio carries, unless a
// picture was chosen by hand. An edition without audio (scans, a PV) shows a picture named like a cover
// (cover, front, folder, 封面, 表紙 …), else its first picture. Releases have no cover of their own: where
// one picture is needed for a release, it is the first cover of its first collected edition.

import { env } from 'cloudflare:workers';
import { db, parseFormat } from './db';
import { coversFor, pictureUrl, picturesFor, readNow } from './embedded';
import { ADMIN_URLS, imageSrc, pictureSrc, type MediaUrls } from './media';
import { derivedFor } from './processing';
import { OPEN_SQL } from './access';
import { PREVIEW_EDGE } from './public/rules';
import { parseCover } from './tags';

export interface Cover {
  src: string; // for showing it (a WebP preview when there is one)
  full: string; // the picture itself
  source: 'chosen' | 'embedded' | 'image';
  file?: { id: string; name: string; folder_id: string | null }; // a picture file (chosen, or the edition's)
  picture?: string; // an embedded picture's sha256
  tracks?: number; // embedded: how many tracks carry it
  width: number | null;
  height: number | null;
  mime: string | null;
  size: number | null;
}

/** Names of pictures that are a cover. */
export const COVER_NAME = /(^|[^a-z])(cover|front|folder|jacket|jkt)([^a-z]|$)|封面|表紙|ジャケット|ジャケ/i;

interface ImageRow {
  id: string;
  edition_id: string;
  name: string;
  download_name: string | null;
  sha256: string | null;
  blob_key: string | null;
  folder_id: string | null;
  format: string | null;
  size: number;
  ext: string;
}

/**
 * The covers of these editions (in order: the track list's, most used first; or the chosen picture; or what
 * the audio carries, most used first; or a picture).
 * `urls` addresses them (the admin's by default); `open` keeps to files the public site shows.
 */
export async function editionCovers(
  editionIds: string[], opts: { read?: boolean; size?: 240 | 640 | 1600; urls?: MediaUrls; open?: boolean } = {},
): Promise<Map<string, Cover[]>> {
  const out = new Map<string, Cover[]>();
  if (editionIds.length === 0) return out;
  const database = db();
  const ids = JSON.stringify([...new Set(editionIds)]);
  const size = opts.size ?? 640;
  const urls = opts.urls ?? ADMIN_URLS;
  // Pictures shown on the public site: picture files open there; the pictures audio files carry when the
  // file is listed and its rights hold nothing back (a track that only lists or only previews still shows its cover).
  const open = opts.open ? `AND ${OPEN_SQL}` : '';
  const carried = opts.open ? "AND f.rights IN ('own', 'licensed') AND coalesce(f.pub_visible, e.pub_visible) = 1" : '';
  if (opts.read) {
    // The tracks' pictures are read from the files once; do it now for those not read yet.
    const { results } = await database
      .prepare(`SELECT DISTINCT sha256 FROM files WHERE edition_id IN (SELECT value FROM json_each(?)) AND kind = 'audio' AND sealed_in IS NULL AND sha256 IS NOT NULL`)
      .bind(ids)
      .all<{ sha256: string }>();
    await readNow(database, env.MEDIA, results.map((r) => r.sha256), 8000).catch(() => 0);
  }
  const [chosen, embedded, images, trackRows, trackCovers] = await database.batch([
    database.prepare(
      `SELECT e.id AS edition_id, f.id, f.name, f.download_name, f.sha256, f.blob_key, f.folder_id, f.format, f.size, f.ext
       FROM editions e JOIN files f ON f.id = e.cover_file_id WHERE e.id IN (SELECT value FROM json_each(?)) ${open}`,
    ).bind(ids),
    database.prepare(
      `SELECT f.edition_id, m.cover, count(DISTINCT coalesce(f.track_id, f.id)) AS n FROM files f JOIN embedded m ON m.sha256 = f.sha256
       JOIN editions e ON e.id = f.edition_id
       WHERE f.edition_id IN (SELECT value FROM json_each(?)) AND f.kind = 'audio' AND f.sealed_in IS NULL AND f.state != 'ignored'
         AND f.dup_of IS NULL AND m.cover IS NOT NULL ${carried}
       GROUP BY f.edition_id, m.cover ORDER BY n DESC`,
    ).bind(ids),
    database.prepare(
      `SELECT f.edition_id, f.id, f.name, f.download_name, f.sha256, f.blob_key, f.folder_id, f.format, f.size, f.ext FROM files f
       JOIN editions e ON e.id = f.edition_id
       WHERE f.edition_id IN (SELECT value FROM json_each(?)) AND f.kind = 'image' AND f.sealed_in IS NULL AND f.state != 'ignored' ${open}
         AND NOT EXISTS (SELECT 1 FROM files a WHERE a.edition_id = f.edition_id AND a.kind = 'audio' AND a.sealed_in IS NULL AND a.state != 'ignored')
       ORDER BY f.edition_id, coalesce(f.download_name, f.name)`,
    ).bind(ids),
    database.prepare('SELECT edition_id, track_id, cover FROM edition_tracks WHERE edition_id IN (SELECT value FROM json_each(?)) ORDER BY edition_id, disc, position').bind(ids),
    database.prepare(
      `SELECT f.edition_id, f.track_id, m.cover FROM files f JOIN embedded m ON m.sha256 = f.sha256
       JOIN editions e ON e.id = f.edition_id
       WHERE f.edition_id IN (SELECT value FROM json_each(?)) AND f.kind = 'audio' AND f.track_id IS NOT NULL AND f.sealed_in IS NULL
         AND f.state != 'ignored' AND f.dup_of IS NULL AND m.cover IS NOT NULL ${carried}
       GROUP BY f.edition_id, f.track_id, m.cover`,
    ).bind(ids),
  ]);
  const chosenRows = chosen.results as ImageRow[];
  const embeddedRows = embedded.results as { edition_id: string; cover: string; n: number }[];
  const imageRows = images.results as ImageRow[];
  // A track list's covers: per row its chosen picture or picture file, else the picture its file carries.
  const rowList = (trackRows.results as { edition_id: string; track_id: string; cover: string | null }[]).map((r) => ({ ...r, chosen: parseCover(r.cover) }));
  const carriedBy = new Map<string, string>();
  for (const r of trackCovers.results as { edition_id: string; track_id: string; cover: string }[]) {
    if (!carriedBy.has(`${r.edition_id}/${r.track_id}`)) carriedBy.set(`${r.edition_id}/${r.track_id}`, r.cover);
  }
  const rowFileIds = [...new Set(rowList.map((r) => r.chosen?.file).filter((x): x is string => !!x))];
  const rowFiles = rowFileIds.length
    ? ((await database
      .prepare(
        `SELECT f.edition_id, f.id, f.name, f.download_name, f.sha256, f.blob_key, f.folder_id, f.format, f.size, f.ext FROM files f
         LEFT JOIN editions e ON e.id = f.edition_id WHERE f.id IN (SELECT value FROM json_each(?)) ${open}`,
      )
      .bind(JSON.stringify(rowFileIds))
      .all<ImageRow>()).results)
    : [];
  const rowFile = new Map(rowFiles.map((r) => [r.id, r]));
  const rowPictures = rowList.flatMap((r) => [r.chosen?.picture, carriedBy.get(`${r.edition_id}/${r.track_id}`)]).filter((x): x is string => !!x);
  const derived = await derivedFor(database, [
    ...chosenRows.map((r) => r.sha256), ...imageRows.map((r) => r.sha256), ...embeddedRows.map((r) => r.cover), ...rowFiles.map((r) => r.sha256), ...rowPictures,
  ]);
  const pictures = await picturesFor([...new Set([...embeddedRows.map((r) => r.cover), ...rowPictures])]);
  const fromFile = (r: ImageRow, source: Cover['source']): Cover => {
    const fmt = parseFormat(r.format);
    // The public site shows large pictures by their previews only.
    const small = !!fmt.width && !!fmt.height && Math.max(fmt.width, fmt.height) <= PREVIEW_EDGE;
    const original = (r.blob_key && (urls.fullPictures || small) ? urls.object(r.blob_key, true) : null) ?? '';
    return {
      src: imageSrc(original || null, r.sha256 ? derived.get(r.sha256) : undefined, size, urls) ?? original, full: original, source,
      file: { id: r.id, name: r.download_name || r.name, folder_id: r.folder_id },
      width: fmt.width ?? null, height: fmt.height ?? null, mime: r.ext.toLowerCase() === 'png' ? 'image/png' : `image/${r.ext.toLowerCase()}`, size: r.size,
    };
  };
  const fromPicture = (sha: string, n: number, source: Cover['source']): Cover => {
    const p = pictures.get(sha);
    // Shown by its preview (the processing program makes them for embedded pictures too); `full` is the picture itself.
    const src = pictureSrc(sha, derived.get(sha), size, urls) ?? '';
    return {
      src, full: opts.urls ? src : pictureUrl(sha), source, picture: sha, tracks: n,
      width: p?.width ?? null, height: p?.height ?? null, mime: p?.mime ?? null, size: p?.size ?? null,
    };
  };
  const byRows = new Map<string, Map<string, { n: number; make: (n: number) => Cover }>>();
  for (const r of rowList) {
    const counts = byRows.get(r.edition_id) ?? new Map<string, { n: number; make: (n: number) => Cover }>();
    byRows.set(r.edition_id, counts);
    const file = r.chosen?.file ? rowFile.get(r.chosen.file) : undefined;
    const sha = r.chosen?.picture ?? (r.chosen?.file ? undefined : carriedBy.get(`${r.edition_id}/${r.track_id}`));
    const key = file ? `f:${file.id}` : sha ? `p:${sha}` : null;
    if (!key) continue;
    const seen = counts.get(key);
    if (seen) seen.n += 1;
    else {
      const source: Cover['source'] = r.chosen ? 'chosen' : 'embedded';
      counts.set(key, { n: 1, make: file ? (n) => ({ ...fromFile(file, source), tracks: n }) : (n) => fromPicture(sha!, n, source) });
    }
  }
  for (const [id, counts] of byRows) {
    const list = [...counts.values()].sort((a, b) => b.n - a.n).map((c) => c.make(c.n)).filter((c) => c.src);
    if (list.length) out.set(id, list);
  }
  for (const r of chosenRows) if (!out.has(r.edition_id)) out.set(r.edition_id, [fromFile(r, 'chosen')]);
  for (const r of embeddedRows) {
    if (byRows.get(r.edition_id)?.size || chosenRows.some((c) => c.edition_id === r.edition_id)) continue;
    out.set(r.edition_id, [...(out.get(r.edition_id) ?? []), fromPicture(r.cover, r.n, 'embedded')]);
  }
  const byEdition = new Map<string, ImageRow[]>();
  for (const r of imageRows) byEdition.set(r.edition_id, [...(byEdition.get(r.edition_id) ?? []), r]);
  for (const [id, list] of byEdition) {
    if (out.has(id)) continue;
    const pick = list.find((r) => COVER_NAME.test((r.download_name || r.name).replace(/\.[^.]+$/, ''))) ?? list[0];
    out.set(id, [fromFile(pick, 'image')]);
  }
  return out;
}

/** Thumbnails for audio files: the picture each carries (by content). */
export async function audioThumbs(shas: (string | null)[]): Promise<Map<string, string>> {
  const covers = await coversFor(shas);
  return new Map([...covers].map(([sha, pic]) => [sha, pictureUrl(pic)]));
}
