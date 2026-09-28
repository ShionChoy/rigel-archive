// The 整理台's 「标签与封面」: the tags one audio file gets in its 整理版 download, edited from the file
// (they live in the catalog: the edition's track row, the track's credits, the edition's album name and
// cover), and 「设为封面」 for a picture. The edition page edits the same things for all tracks at once.

import { ChangeSet } from './changes';
import { db, parseFormat, type EditionRow, type FileRow, type ReleaseRow } from './db';
import { CREDIT_FIELDS, loadEditionTracks, parseCredits, trackTitle, type Credits, type EditionTrackView } from './editions';
import { N_, summary, UserError } from './i18n';
import { newId } from './ids';
import { derivedFor } from './processing';
import { imageSrc } from './media';
import { albumArtist, editionContext, tagSet, taggedSource } from './tags';
import { loadTracks, titleFromFile, titleKey, trackNumber } from './tracks';

/** Pictures a 整理版 can embed. */
export const COVER_SQL = "kind = 'image' AND lower(ext) IN ('jpg', 'jpeg', 'png') AND size < 12000000 AND sealed_in IS NULL";

type FileForTags = Pick<
  FileRow,
  'id' | 'name' | 'download_name' | 'ext' | 'size' | 'mtime' | 'sha256' | 'kind' | 'blob_key' | 'edition_id' | 'release_id' | 'track_id' | 'format' | 'dir'
>;

export interface TagEditView {
  file: { id: string; name: string; trackId: string | null; taggable: boolean; embedded: Record<string, string>; embeddedCover: boolean };
  edition: { id: string; label: string; album_title: string; album: string; release_title: string; artist: string; date: string; catalog: string } | null;
  row: { id: string; disc: number; position: number; title: string; entry_title: string; track_id: string } | null;
  credits: Credits;
  entries: { id: string; title: string; inEdition: boolean; rowTitle: string; credits: Credits }[];
  tags: { title: string; artist: string; album: string; track: string; date: string; catalog: string } | null;
  cover: { from: 'edition' | 'release' | 'file' | 'none'; id: string | null; src: string | null }; // what the 整理版 embeds
  covers: { id: string; name: string; src: string | null; here: boolean }[]; // pictures that can be the edition's cover
  editionCover: string | null;
  releaseCover: { id: string; src: string | null } | null;
  ownCover: string | null; // the picture embedded in the file
}

async function loadFile(id: string): Promise<FileForTags> {
  const f = await db()
    .prepare('SELECT id, name, download_name, ext, size, mtime, sha256, kind, blob_key, edition_id, release_id, track_id, format, dir FROM files WHERE id = ?')
    .bind(id)
    .first<FileForTags>();
  if (!f) throw new UserError('找不到文件');
  return f;
}

async function editionOf(id: string): Promise<{ edition: EditionRow; release: ReleaseRow & { era_name: string } }> {
  const database = db();
  const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(id).first<EditionRow>();
  if (!edition) throw new UserError('找不到版本');
  const release = await database
    .prepare('SELECT r.*, e.name AS era_name FROM releases r JOIN eras e ON e.id = r.era_id WHERE r.id = ?')
    .bind(edition.release_id)
    .first<ReleaseRow & { era_name: string }>();
  if (!release) throw new UserError('找不到作品');
  return { edition, release };
}

const editionLabel = (release: ReleaseRow, edition: EditionRow) => `${release.catalog_no ?? release.title} ${edition.name}`.trim();

/** What the 「标签与封面」 dialog shows for one file. */
export async function tagEditView(fileId: string): Promise<TagEditView> {
  const file = await loadFile(fileId);
  const fmt = parseFormat(file.format);
  const embedded = Object.fromEntries(Object.entries(fmt.tags ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  const base = { id: file.id, name: file.download_name || file.name, trackId: file.track_id, embedded, embeddedCover: !!fmt.cover, taggable: false };
  const ownCover = fmt.cover && file.blob_key ? `/admin/files/${file.id}/cover` : null;
  const empty: TagEditView = {
    file: base, edition: null, row: null, credits: {}, entries: [], tags: null, covers: [], editionCover: null, releaseCover: null, ownCover,
    cover: { from: ownCover ? 'file' : 'none', id: null, src: ownCover },
  };
  if (file.kind !== 'audio' || !file.edition_id) return empty;
  const database = db();
  const { edition, release } = await editionOf(file.edition_id);
  const [rows, entries, ctx, images] = await Promise.all([
    loadEditionTracks(edition.id),
    loadTracks(release.id),
    editionContext(edition.id),
    database
      .prepare(`SELECT id, name, sha256, blob_key, edition_id FROM files WHERE release_id = ? AND ${COVER_SQL} ORDER BY edition_id = ? DESC, name LIMIT 60`)
      .bind(release.id, edition.id)
      .all<{ id: string; name: string; sha256: string | null; blob_key: string | null; edition_id: string | null }>(),
  ]);
  const [derived, source] = await Promise.all([derivedFor(database, images.results.map((i) => i.sha256)), taggedSource(file, ctx)]);
  const thumb = (i: { sha256: string | null; blob_key: string | null }) => imageSrc(i.blob_key ? `/admin/media/${i.blob_key}` : null, i.sha256 ? derived.get(i.sha256) : undefined, 240);
  const row = file.track_id ? rows.find((r) => r.track_id === file.track_id) ?? null : null;
  const entry = file.track_id ? entries.find((e) => e.id === file.track_id) : undefined;
  const tags = ctx ? tagSet(ctx, row ?? undefined, fmt.tags?.title ?? file.name.replace(/\.[^.]+$/, '')) : null;
  const coverId = edition.cover_file_id ?? release.cover_file_id;
  const coverRow = coverId ? images.results.find((i) => i.id === coverId) : undefined;
  const releaseCover = release.cover_file_id ? images.results.find((i) => i.id === release.cover_file_id) : undefined;
  const artist = albumArtist(release, release.era_name);
  const inEdition = new Set(rows.map((r) => r.track_id));
  return {
    file: { ...base, taggable: !!source },
    edition: {
      id: edition.id, label: editionLabel(release, edition), album_title: edition.album_title ?? '', album: edition.album_title || release.title,
      release_title: release.title, artist, date: edition.release_date || release.release_date || '', catalog: edition.catalog_no || release.catalog_no || '',
    },
    row: row ? { id: row.id, disc: row.disc, position: row.position, title: row.title ?? '', entry_title: trackTitle({ ...row, title: null }), track_id: row.track_id } : null,
    credits: parseCredits(entry?.credits),
    entries: entries.map((e) => ({
      id: e.id, title: e.version_label ? `${e.title} (${e.version_label})` : e.title, inEdition: inEdition.has(e.id),
      rowTitle: rows.find((r) => r.track_id === e.id)?.title ?? '', credits: parseCredits(e.credits),
    })),
    tags: tags && {
      title: tags.title, artist: tags.artist, album: tags.album, date: tags.date ?? '', catalog: tags.catalog ?? '',
      track: tags.track ? `${tags.disc ? `${tags.disc}-` : ''}${tags.track}${tags.trackTotal ? ` / ${tags.trackTotal}` : ''}` : '',
    },
    cover: coverRow
      ? { from: edition.cover_file_id ? 'edition' : 'release', id: coverRow.id, src: thumb(coverRow) }
      : coverId
        ? { from: edition.cover_file_id ? 'edition' : 'release', id: coverId, src: null }
        : { from: ownCover ? 'file' : 'none', id: null, src: ownCover },
    covers: images.results.map((i) => ({ id: i.id, name: i.name, src: thumb(i), here: i.edition_id === edition.id })),
    editionCover: edition.cover_file_id,
    releaseCover: release.cover_file_id ? { id: release.cover_file_id, src: releaseCover ? thumb(releaseCover) : null } : null,
    ownCover,
  };
}

export interface TagInput {
  title: string;
  credits: Credits;
  album_title: string;
  entry: string; // '' = the file's track as it is (a new one when it has none), 'new', or a track id of the release
  cover?: string; // '' = the release's cover (or the file's own), or an image's file id; absent = unchanged
}

/** Save the 整理版 tags of one audio file. Returns the rows changed and the batch. */
export async function saveFileTags(actor: string, fileId: string, input: TagInput): Promise<{ changed: number; batchId: string; summary: string }> {
  const file = await loadFile(fileId);
  if (file.kind !== 'audio') throw new UserError('只有音频文件有整理版标签');
  if (!file.edition_id) throw new UserError('先把文件放进某个版本：整理版标签来自版本的曲目表');
  const title = input.title.trim().slice(0, 300);
  const albumTitle = input.album_title.trim().slice(0, 300);
  const { edition, release } = await editionOf(file.edition_id);
  const [rows, entries] = await Promise.all([loadEditionTracks(edition.id), loadTracks(release.id)]);
  const database = db();
  const cs = new ChangeSet(database, actor, summary(N_('文件 {name}：修改整理版标签'), { name: file.download_name || file.name }));

  // Which track the file is: its own, another of the release, or a new one.
  let trackId: string | null = input.entry === 'new' ? null : input.entry || file.track_id;
  if (trackId && !entries.some((e) => e.id === trackId)) throw new UserError('所选曲目条目不属于这个作品');
  let row: EditionTrackView | null = trackId ? rows.find((r) => r.track_id === trackId) ?? null : null;
  const entry = trackId ? entries.find((e) => e.id === trackId)! : null;
  const credits = (from: Credits): string | null => {
    const next: Credits = { ...from };
    for (const f of CREDIT_FIELDS) {
      const v = (input.credits[f] ?? '').trim().slice(0, 300);
      if (v) next[f] = v;
      else delete next[f];
    }
    return Object.keys(next).length ? JSON.stringify(next) : null;
  };
  if (!trackId) {
    const name = title || titleFromFile(file);
    trackId = newId('t');
    const songId = newId('s');
    cs.create('song', { id: songId, title: name, note: null });
    cs.create('track', {
      id: trackId, release_id: release.id, disc: 1, position: entries.reduce((m, e) => Math.max(m, e.position), 0) + 1, title: name, song_id: songId,
      version_label: null, duration_ms: durationMs(file), credits: credits({}), note: null, external_ids: '{}',
    });
  }
  if (!row) {
    // A new row at the end of the file's disc (the edition page puts it in order).
    const wanted = trackNumber(file).disc;
    const disc = rows.some((r) => r.disc === wanted) ? wanted : rows.at(-1)?.disc ?? 1;
    const position = rows.filter((r) => r.disc === disc).reduce((m, r) => Math.max(m, r.position), 0) + 1;
    const entryTitle = entry ? entry.title : title || titleFromFile(file);
    cs.create('edition_track', {
      id: newId('et'), edition_id: edition.id, disc, position, track_id: trackId,
      title: title && titleKey(title) !== titleKey(entryTitle) ? title : null, duration_ms: durationMs(file), external_ids: '{}',
    });
  } else {
    const own = title && title !== trackTitle({ ...row, title: null }) ? title : null;
    cs.updateKnown('edition_track', { id: row.id }, row as unknown as Record<string, unknown>, { title: own });
  }
  if (file.track_id !== trackId) cs.updateKnown('file', { id: file.id }, { track_id: file.track_id }, { track_id: trackId });

  // Credits belong to the track (every edition that has it).
  if (entry) cs.updateKnown('track', { id: entry.id }, entry as unknown as Record<string, unknown>, { credits: credits(parseCredits(entry.credits)) });

  // The album name and the cover belong to the edition.
  const album = albumTitle && albumTitle !== release.title ? albumTitle : null;
  cs.updateKnown('edition', { id: edition.id }, { album_title: edition.album_title }, { album_title: album });
  if (input.cover !== undefined) {
    const cover = input.cover || null;
    if (cover) await checkCover(cover, release.id);
    cs.updateKnown('edition', { id: edition.id }, { cover_file_id: edition.cover_file_id }, { cover_file_id: cover });
  }
  const changed = await cs.commit();
  return { changed, batchId: cs.batchId, summary: cs.summary };
}

const durationMs = (f: Pick<FileRow, 'format'>) => {
  const s = parseFormat(f.format).duration;
  return s ? Math.round(s * 1000) : null;
};

async function checkCover(imageId: string, releaseId: string) {
  const ok = await db().prepare(`SELECT 1 FROM files WHERE id = ? AND release_id = ? AND ${COVER_SQL}`).bind(imageId, releaseId).first();
  if (!ok) throw new UserError('封面要从这个作品的 JPEG / PNG 图片里选（12 MB 以内）');
}

/** 「设为封面」: a picture becomes the cover of its edition, or of its release when it is in no edition. */
export async function setCover(actor: string, imageId: string): Promise<{ changed: number; batchId: string; summary: string }> {
  const database = db();
  const image = await database.prepare('SELECT id, name, kind, ext, size, release_id, edition_id, sealed_in FROM files WHERE id = ?').bind(imageId).first<FileRow>();
  if (!image) throw new UserError('找不到文件');
  if (image.kind !== 'image') throw new UserError('只有图片可以设为封面');
  if (!image.release_id) throw new UserError('先把图片放进某个作品或版本，再设为封面');
  if (!/^(jpe?g|png)$/i.test(image.ext) || image.size >= 12000000) throw new UserError('整理版只能嵌入 12 MB 以内的 JPEG 或 PNG 图片');
  if (image.edition_id) {
    const { edition, release } = await editionOf(image.edition_id);
    const cs = new ChangeSet(database, actor, summary(N_('版本 {edition}：封面设为 {name}'), { edition: editionLabel(release, edition), name: image.name }));
    cs.updateKnown('edition', { id: edition.id }, { cover_file_id: edition.cover_file_id }, { cover_file_id: image.id });
    return { changed: await cs.commit(), batchId: cs.batchId, summary: cs.summary };
  }
  const release = await database.prepare('SELECT id, catalog_no, title, cover_file_id FROM releases WHERE id = ?').bind(image.release_id).first<ReleaseRow>();
  if (!release) throw new UserError('找不到作品');
  const cs = new ChangeSet(database, actor, summary(N_('作品 {release}：封面设为 {name}'), { release: release.catalog_no ?? release.title, name: image.name }));
  cs.updateKnown('release', { id: release.id }, { cover_file_id: release.cover_file_id }, { cover_file_id: image.id });
  return { changed: await cs.commit(), batchId: cs.batchId, summary: cs.summary };
}
