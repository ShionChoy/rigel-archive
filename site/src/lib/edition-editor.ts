// The edition page's tag editor (版本页): what it shows (every track row with the tags its file carries and
// the tags the row sets, the covers, the pictures a cover can be chosen from) and saving what the admin
// changed there: one batch in the history, so one 「撤销」 undoes it.
//
// The page's script (scripts/edition.ts) keeps its changes to itself until 「保存」 and then sends the whole
// track list as it should be (order, disc, tags, cover of every row), with new rows and removed ones.

import { env } from 'cloudflare:workers';
import { ChangeSet } from './changes';
import { db, parseFormat, type EditionRow, type ReleaseRow } from './db';
import { editionAudio, parseIds } from './editions';
import { embeddedFor, pictureUrl, picturesFor, readNow } from './embedded';
import { formatSpec } from './format';
import { summary, UserError, type T } from './i18n';
import { newId } from './ids';
import { imageSrc } from './media';
import { Places, ensureEntityFolder, folderKey, freeFileName } from './locations';
import { derivedFor } from './processing';
import { newRowTags } from './rowtags';
import { COMMON_TAGS, TAG_DEFS, tagLabel } from './tagging/names';
import { cleanTags, parseTags, sameValues, type Tags } from './tagging/model';
import { COVER_MAX, parseCover, type RowCover } from './tags';
import { titleFromFile, titleKey } from './tracks';

export type { RowCover };

export interface EdFile {
  id: string;
  name: string;
  ext: string;
  spec: string;
  size: number;
  duration: number | null;
  track_id: string | null;
  cover: string | null; // the picture it carries (sha256)
  original: Tags; // 文件原值
  read: boolean; // its tags have been read
  lossless: boolean;
  path: string; // folder path below the edition
}

export interface EdRow {
  id: string;
  disc: number;
  position: number;
  track_id: string;
  entry_title: string;
  duration_ms: number | null;
  tags: Tags; // what the row sets over the file's own
  cover: RowCover | null;
  files: string[]; // file ids, the main one first
}

export interface EdPicture {
  key: string; // file:<id> or picture:<sha256>
  src: string;
  full: string;
  label: string; // «扫图/01 封面.jpg» (its folders below the edition), or «曲目自带»
  width: number | null;
  height: number | null;
  mime: string;
  size: number;
  embeddable: boolean; // can go into downloads (JPEG / PNG, or a large one with its 1600 px copy)
  tracks: number; // embedded: how many files carry it
  kind: 'file' | 'embedded';
}

export interface EditorData {
  edition: { id: string; label: string; release: string; search: string }; // search: what 「查找元数据」 looks for first
  version: string; // of the track list as loaded; saving refuses when it changed meanwhile
  rows: EdRow[];
  files: Record<string, EdFile>;
  unlinked: string[]; // audio files of the edition with no row
  pictures: EdPicture[];
  display: string[]; // tags always shown (common ones and the team's list)
  tagDefs: { name: string; label: string; group: string }[];
  unread: number; // audio files whose own tags have not been read yet
}

// ------------------------------------------------------------------------------------------ the team's display list

const DISPLAY_KEY = 'tag_display';

/** The tags shown even when empty: the common ones, then the ones the team added. */
export async function displayTags(): Promise<string[]> {
  const row = await db().prepare('SELECT value FROM meta WHERE key = ?').bind(DISPLAY_KEY).first<{ value: string }>();
  let extra: string[] = [];
  try {
    const v = JSON.parse(row?.value ?? '[]');
    if (Array.isArray(v)) extra = v.filter((x): x is string => typeof x === 'string');
  } catch {
    // none
  }
  return [...new Set([...COMMON_TAGS, ...extra])];
}

export async function saveDisplayTags(names: string[]): Promise<void> {
  const clean = [...new Set(names.map((n) => String(n).trim().toLowerCase()).filter((n) => n && n.length <= 60 && !COMMON_TAGS.includes(n)))].slice(0, 100);
  await db().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(DISPLAY_KEY, JSON.stringify(clean)).run();
}

// ------------------------------------------------------------------------------------------ loading

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

interface RawRow {
  id: string;
  disc: number;
  position: number;
  track_id: string;
  entry_title: string;
  version_label: string | null;
  title: string | null;
  duration_ms: number | null;
  entry_duration: number | null;
  tags: string;
  cover: string | null;
}

async function loadRows(editionId: string): Promise<RawRow[]> {
  const { results } = await db()
    .prepare(
      `SELECT et.id, et.disc, et.position, et.track_id, et.duration_ms, et.tags, et.cover,
              t.title AS entry_title, t.version_label, t.duration_ms AS entry_duration
       FROM edition_tracks et JOIN tracks t ON t.id = et.track_id WHERE et.edition_id = ? ORDER BY et.disc, et.position, et.id`,
    )
    .bind(editionId)
    .all<RawRow>();
  return results;
}

/** The version of a track list: changes when any row's order, disc, tags or cover changes. */
async function listVersion(rows: RawRow[]): Promise<string> {
  return sha256(JSON.stringify(rows.map((r) => [r.id, r.disc, r.position, parseTags(r.tags), r.cover ?? null])));
}

export async function editorData(edition: EditionRow, release: ReleaseRow, places: Places, t: T): Promise<EditorData> {
  const database = db();
  const [rawRows, audio] = await Promise.all([loadRows(edition.id), editionAudio(edition.id)]);
  // The files' own tags are read once; the ones not read yet are read now (a few seconds at most).
  await readNow(database, env.MEDIA, audio.map((f) => f.sha256), 8000).catch(() => 0);
  const [own, images] = await Promise.all([
    embeddedFor(audio.map((f) => f.sha256)),
    database
      .prepare(
        `SELECT id, name, download_name, ext, size, sha256, blob_key, folder_id, format FROM files
         WHERE edition_id = ? AND kind = 'image' AND sealed_in IS NULL AND state != 'ignored' ORDER BY folder_id, coalesce(download_name, name)`,
      )
      .bind(edition.id)
      .all<{ id: string; name: string; download_name: string | null; ext: string; size: number; sha256: string | null; blob_key: string | null; folder_id: string | null; format: string | null }>(),
  ]);
  const home = places.editionFolder(edition.id);
  const pathOf = (folderId: string | null) => {
    if (!folderId || !home || folderId === home.id) return '';
    const chain = places.chain(`fd:${folderId}`);
    return chain.slice(chain.indexOf(`fd:${home.id}`) + 1).map((k) => places.name(k, t)).join('/');
  };
  const { results: extra } = await database
    .prepare(`SELECT id, folder_id, json_extract(format, '$.duration') AS duration FROM files WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(audio.map((f) => f.id)))
    .all<{ id: string; folder_id: string | null; duration: number | null }>();
  const folderOf = new Map(extra.map((r) => [r.id, r.folder_id]));
  const files: Record<string, EdFile> = {};
  for (const f of audio) {
    const fmt = parseFormat(f.format);
    const e = f.sha256 ? own.get(f.sha256) : undefined;
    files[f.id] = {
      id: f.id, name: f.name, ext: f.name.split('.').pop()?.toLowerCase() ?? '', spec: formatSpec({ ...fmt, duration: undefined }), size: 0,
      duration: fmt.duration ?? null, track_id: f.track_id, cover: e?.cover ?? null, original: e?.tags ?? {}, read: !!e, lossless: !!fmt.lossless,
      path: pathOf(folderOf.get(f.id) ?? null),
    };
  }
  // A row's files: the lossless ones first (FLAC before WAV), its tags are shown from the first.
  const rank = (f: EdFile) => (f.lossless ? 0 : 2) + (f.ext === 'flac' ? 0 : 1);
  const rows: EdRow[] = rawRows.map((r) => ({
    id: r.id, disc: r.disc, position: r.position, track_id: r.track_id,
    entry_title: r.version_label ? `${r.entry_title} (${r.version_label})` : r.entry_title,
    duration_ms: r.duration_ms ?? r.entry_duration, tags: parseTags(r.tags), cover: parseCover(r.cover),
    files: Object.values(files).filter((f) => f.track_id === r.track_id).sort((a, b) => rank(a) - rank(b)).map((f) => f.id),
  }));
  const linked = new Set(rows.flatMap((r) => r.files));
  // Pictures: the edition's picture files (with their place below it), then the pictures its audio carries.
  const derived = await derivedFor(database, images.results.map((i) => i.sha256));
  const pictures: EdPicture[] = images.results.map((i) => {
    const fmt = parseFormat(i.format);
    const original = i.blob_key ? `/admin/media/${i.blob_key}` : '';
    const d = i.sha256 ? derived.get(i.sha256) : undefined;
    const path = pathOf(i.folder_id);
    const small = /^(jpe?g|png)$/i.test(i.ext) && i.size < COVER_MAX;
    return {
      key: `file:${i.id}`, src: imageSrc(original || null, d, 640) ?? original, full: original, label: `${path ? `${path}/` : ''}${i.download_name || i.name}`,
      width: fmt.width ?? null, height: fmt.height ?? null, mime: i.ext.toLowerCase() === 'png' ? 'image/png' : `image/${i.ext.toLowerCase()}`,
      size: i.size, embeddable: small || !!d?.get('embed'), tracks: 0, kind: 'file',
    };
  });
  const counts = new Map<string, number>();
  for (const f of audio) {
    const e = f.sha256 ? own.get(f.sha256) : undefined;
    for (const p of e?.pictures ?? []) counts.set(p.sha256, (counts.get(p.sha256) ?? 0) + 1);
  }
  const info = await picturesFor([...counts.keys()]);
  for (const [sha, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const p = info.get(sha);
    pictures.push({
      key: `picture:${sha}`, src: pictureUrl(sha), full: pictureUrl(sha), label: t('曲目自带'), width: p?.width ?? null, height: p?.height ?? null,
      mime: p?.mime ?? 'image/jpeg', size: p?.size ?? 0, embeddable: (p?.size ?? 0) < COVER_MAX, tracks: n, kind: 'embedded',
    });
  }
  const tagText = (name: string) => {
    const l = tagLabel(name);
    return l.role !== undefined ? t(l.text, { role: l.role }) : t(l.text);
  };
  return {
    edition: {
      id: edition.id, label: places.editionLabel(edition, t), release: release.catalog_no ?? release.title,
      search: [edition.catalog_no ?? release.catalog_no, edition.album_title || release.title].filter(Boolean).join(' '),
    },
    version: await listVersion(rawRows),
    rows,
    files,
    unlinked: Object.keys(files).filter((id) => !linked.has(id)),
    pictures,
    display: await displayTags(),
    tagDefs: TAG_DEFS.map((d) => ({ name: d.name, label: tagText(d.name), group: d.group })),
    unread: audio.filter((f) => f.sha256 && !own.has(f.sha256)).length,
  };
}

// ------------------------------------------------------------------------------------------ saving

export interface SaveRow {
  id: string; // an existing row, or «new:<file id>» / «blank:<n>» for rows added on the page
  disc: number;
  tags: Record<string, unknown>;
  cover: RowCover | null;
  title?: string; // blank rows: the title of the new track
}

export interface SaveBody {
  version: string;
  edition_ids?: { musicbrainz_release?: string; bandcamp?: string } | null; // the source whose data was taken (查找元数据)
  rows: SaveRow[]; // every row, in the order wanted
  links?: { file: string; row: string | null }[]; // audio files to link to a row (or to none)
}

function checkCover(raw: unknown): RowCover | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = parseCover(JSON.stringify(raw));
  if (!c) throw new UserError('封面的选择无效');
  return c;
}

const coverJson = (c: RowCover | null) => (c ? JSON.stringify(c.file ? { file: c.file, mode: c.mode } : { picture: c.picture, mode: c.mode }) : null);

/**
 * Save the track list as the page sends it. Rows keep their ids; positions are renumbered per disc in the
 * order sent. Rows missing from the list are removed; rows «new:<file>» become a new track of the release
 * with that file linked; «blank:<n>» a new track with only a title. Returns the rows changed.
 */
export async function saveEditionTags(actor: string, edition: EditionRow, release: ReleaseRow & { era_name: string }, body: SaveBody): Promise<{ changed: number; batchId: string }> {
  const database = db();
  const current = await loadRows(edition.id);
  if (body.version !== (await listVersion(current))) throw new UserError('曲目表已被别人修改，请刷新后重试（你的改动没有保存）');
  if (!Array.isArray(body.rows) || body.rows.length > 999) throw new UserError('曲目表无效');
  const byId = new Map(current.map((r) => [r.id, r]));
  const audio = await editionAudio(edition.id);
  const audioById = new Map(audio.map((f) => [f.id, f]));
  const cs = new ChangeSet(database, actor, summary('版本 {edition}：修改标签与曲目表', { edition: `${release.catalog_no ?? release.title} ${edition.name}`.trim() }));
  const kept = new Set<string>();
  const counters = new Map<number, number>();
  const { results: entries } = await database.prepare('SELECT id, title, position FROM tracks WHERE release_id = ?').bind(release.id).all<{ id: string; title: string; position: number }>();
  let nextPosition = entries.reduce((m, e) => Math.max(m, e.position), 0);
  const madeFor = new Map<string, string>(); // page row id → track id (new rows)
  const albumRows = current.map((r) => r.tags);
  for (const [i, r] of body.rows.entries()) {
    const disc = Number(r.disc) || 1;
    if (!Number.isInteger(disc) || disc < 1 || disc > 99) throw new UserError('第 {row} 行：碟号应为 1–99', { row: i + 1 });
    const position = (counters.get(disc) ?? 0) + 1;
    counters.set(disc, position);
    const tags = cleanTags(r.tags && typeof r.tags === 'object' ? (r.tags as Record<string, unknown>) : {});
    const cover = checkCover(r.cover);
    const old = byId.get(r.id);
    if (old) {
      kept.add(r.id);
      const oldTags = parseTags(old.tags);
      const sameTags = Object.keys(oldTags).length === Object.keys(tags).length && Object.entries(tags).every(([k, v]) => k in oldTags && sameValues(oldTags[k], v));
      cs.updateKnown('edition_track', { id: old.id }, old as unknown as Record<string, unknown>, {
        disc, position, tags: sameTags ? old.tags : JSON.stringify(tags), cover: coverJson(cover) === (old.cover ? coverJson(parseCover(old.cover)) : null) ? old.cover : coverJson(cover),
      });
      continue;
    }
    // A new row: a new track of the release (with its own song), from a file of the edition or blank.
    let title = (tags.title?.[0] ?? String(r.title ?? '')).trim();
    let file: (typeof audio)[number] | undefined;
    if (r.id.startsWith('new:')) {
      file = audioById.get(r.id.slice(4));
      if (!file) throw new UserError('第 {row} 行：这个文件不在这个版本里', { row: i + 1 });
      title ||= titleFromFile(file);
    } else if (!r.id.startsWith('blank:')) throw new UserError('曲目表已被别人修改，请刷新后重试（你的改动没有保存）');
    if (!title) throw new UserError('第 {row} 行：新曲目需要标题', { row: i + 1 });
    const same = entries.find((e) => titleKey(e.title) === titleKey(title) && !current.some((c) => c.track_id === e.id) && ![...madeFor.values()].includes(e.id));
    let trackId = file?.track_id && entries.some((e) => e.id === file!.track_id) && !current.some((c) => c.track_id === file!.track_id) ? file.track_id : same?.id;
    if (!trackId) {
      trackId = newId('t');
      const songId = newId('s');
      nextPosition += 1;
      const seconds = file ? parseFormat(file.format).duration : undefined;
      cs.create('song', { id: songId, title, note: null });
      cs.create('track', {
        id: trackId, release_id: release.id, disc: 1, position: nextPosition, title, song_id: songId, version_label: null,
        duration_ms: seconds ? Math.round(seconds * 1000) : null, credits: null, note: null, external_ids: '{}',
      });
    }
    madeFor.set(r.id, trackId);
    const start = Object.keys(tags).length ? tags : newRowTags(albumRows, release, edition, title);
    if (!start.title?.length) start.title = [title];
    cs.create('edition_track', {
      id: newId('et'), edition_id: edition.id, disc, position, track_id: trackId, duration_ms: null, external_ids: '{}',
      tags: JSON.stringify(start), cover: coverJson(cover),
    });
    if (file && file.track_id !== trackId) cs.updateFiles([file.id], { track_id: trackId });
  }
  for (const r of current) if (!kept.has(r.id)) await cs.delete('edition_track', { id: r.id });
  // The release whose data was taken is recorded with the edition (its external links).
  if (body.edition_ids && typeof body.edition_ids === 'object') {
    const ids = { ...parseIds(edition.external_ids) };
    const mb = String(body.edition_ids.musicbrainz_release ?? '');
    const bc = String(body.edition_ids.bandcamp ?? '');
    if (/^[0-9a-f-]{36}$/.test(mb)) ids.musicbrainz_release = mb;
    if (/^https:\/\/[a-z0-9-]+\.bandcamp\.com\//i.test(bc)) ids.bandcamp = bc;
    cs.updateKnown('edition', { id: edition.id }, { external_ids: edition.external_ids }, { external_ids: JSON.stringify(ids) });
  }
  // Files linked to rows by hand.
  const trackOfRow = new Map([...current.map((r) => [r.id, r.track_id] as const), ...madeFor]);
  const groups = new Map<string, string[]>();
  for (const l of body.links ?? []) {
    const f = audioById.get(String(l.file));
    if (!f) continue;
    const track = l.row ? trackOfRow.get(String(l.row)) : null;
    if (l.row && !track) throw new UserError('所选曲目不在这个版本里');
    if ((f.track_id ?? null) === (track ?? null)) continue;
    groups.set(track ?? '', [...(groups.get(track ?? '') ?? []), f.id]);
  }
  for (const [track, ids] of groups) cs.updateFiles(ids, { track_id: track || null });
  const changed = await cs.commit();
  return { changed, batchId: cs.batchId };
}

// ------------------------------------------------------------------------------------------ uploaded covers

/**
 * For the cover dialog's «upload»: an uploaded picture is stored and filed in the edition's own folder
 * (the organizers move it where they like).
 */
export async function uploadPicture(actor: string, edition: EditionRow, file: File, t: T): Promise<string> {
  if (!/^image\/(jpeg|png)$/.test(file.type)) throw new UserError('只能上传 JPEG 或 PNG 图片');
  if (file.size > 30_000_000) throw new UserError('图片太大（最多 30 MB）');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `blobs/${sha}`;
  if (!(await env.MEDIA.head(key))) await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type } });
  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const places = await Places.load();
  // An edition without a folder yet gets an empty one below, so only an existing folder can hold the name.
  const name = await freeFileName(places.folderOf(`ed:${edition.id}`)?.id ?? null,
    (file.name || `cover.${ext}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150));
  const id = newId('f');
  const { imageSize } = await import('./tagging/bytes');
  const size = imageSize(bytes);
  const cs = new ChangeSet(db(), actor, summary('版本 {edition}：上传封面图片 {name}', { edition: edition.name || edition.id, name }));
  const place = places.place(folderKey(ensureEntityFolder(cs, places, `ed:${edition.id}`)));
  cs.createFiles([{
    id, origin: 'upload', source_path: null, dir: '后台上传', member_of: null, member_path: null, name, ext, size: file.size,
    mtime: new Date().toISOString(), sha256: sha, blob_key: key, kind: 'image',
    format: JSON.stringify(size ? { width: size.width, height: size.height } : {}), pcm_md5: null, rights: 'own', state: 'classified',
    release_id: place.release_id, slot: place.slot, track_id: null, role: 'cover', dup_of: null, suggest: null, download_name: null, note: null,
    uploaded_by: actor, checked_at: new Date().toISOString(), folder_id: place.folder_id, edition_id: place.edition_id, sealed: 0, sealed_in: null,
  }]);
  await cs.commit();
  void t;
  return id;
}
