// Registering files uploaded from the admin (/admin/upload). The browser has already hashed the file
// and put its bytes in storage under blobs/<sha256>; this adds the file to the 整理台.
// Uploads work like a cloud drive: every file is added as it is, with the folders it came in, even when
// the same content is already in the archive; archives stay whole (their contents are only listed).

import { SHA256_HEX, blobKey } from './api';
import { ChangeSet } from './changes';
import { UPLOAD_ROOT, kindFor } from './constants';
import { N_, summary, UserError } from './i18n';
import { newId } from './ids';
import { suggestedPlace } from './inbox';
import { Places, freeFileName, markEditionsCollected, placePatch } from './locations';

export interface UploadInput {
  batch: string; // one upload session = one revision batch, undone together
  batchDir: string; // 后台上传/<session>
  path: string; // relative path from the upload page ("folder/file.flac")
  size: number;
  mtime: string | null;
  sha256: string;
  release: string | null;
  slot: string | null;
  place: string | null; // era:/rel:/ed:/fd: key chosen on the upload page (the uploaded folders come along below it)
  folder: string | null; // a new folder under the place, chosen in the picker
  note: string | null;
}

export interface Registered {
  id: string;
  /** The name it shows when the folder it went to already had a file of that name («cover (2).jpg»). */
  renamed: string | null;
}

/**
 * Uploads the processing program may open as archives. They are kept whole: the contents are listed on the
 * file's page, and 「展开」 brings them to the 整理台 one by one. (An .exe that turns out to be a plain
 * program has no contents; the flag then shows nowhere, since every view asks isArchive too.)
 */
export function keptWhole(kind: string, ext: string): boolean {
  return kind === 'archive' || kind === 'disc_image' || ext === 'exe';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BATCH_DIR = new RegExp(`^${UPLOAD_ROOT}/[^/]{1,60}$`);

function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s.length > max) throw new UserError('内容过长');
  return s === '' ? null : s;
}

export function uploadSummary(batchDir: string): string {
  return summary('后台上传：{session}', { session: batchDir.slice(UPLOAD_ROOT.length + 1) });
}

export function parseUpload(body: Record<string, unknown>): UploadInput {
  const batch = String(body.batch ?? '');
  const batchDir = String(body.batchDir ?? '');
  const sha256 = String(body.sha256 ?? '');
  const size = Number(body.size);
  if (!UUID.test(batch)) throw new UserError('上传批次无效，请刷新页面');
  if (!BATCH_DIR.test(batchDir)) throw new UserError('上传目录无效');
  if (!SHA256_HEX.test(sha256)) throw new UserError('SHA-256 无效');
  if (!Number.isSafeInteger(size) || size < 0) throw new UserError('文件大小无效');
  const mtime = text(body.mtime, 40);
  if (mtime && Number.isNaN(Date.parse(mtime))) throw new UserError('修改时间无效');
  const slot = text(body.slot, 20);
  if (slot && !/^[\w-]{1,40}$/.test(slot)) throw new UserError('未知的版本类型');
  const release = text(body.release, 100);
  if (slot && !release) throw new UserError('选择版本类型前要先选作品');
  const place = text(body.place, 80);
  if (place && !/^((era|rel|ed|fd):[\w-]{1,80}|top)$/.test(place)) throw new UserError('找不到这个位置');
  return {
    batch, batchDir, sha256, size, slot, release, place,
    folder: text(body.folder, 200)?.replace(/\//g, '_') ?? null,
    path: String(body.path ?? ''),
    mtime: mtime ? new Date(mtime).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    note: text(body.note, 2000),
  };
}

/** Split a browser-supplied relative path into safe folder names and a file name. */
export function splitPath(path: string): { dirs: string[]; name: string } {
  const parts = path.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) throw new UserError('缺少文件名');
  if (parts.some((p) => p === '..' || p.length > 255)) throw new UserError('文件路径无效：{path}', { path });
  if (parts.length > 20) throw new UserError('文件夹层级太深');
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] };
}

function newFileId(): string {
  return newId('f');
}

export async function registerUpload(db: D1Database, media: R2Bucket, actor: string, input: UploadInput): Promise<Registered> {
  const { dirs, name } = splitPath(input.path);
  const key = blobKey(input.sha256);
  const object = await media.head(key);
  if (!object) throw new UserError('存储里还没有这个文件，请重新上传');
  if (object.size !== input.size) throw new UserError('存储里的文件大小与上传的不一致');
  if (input.release) {
    const release = await db.prepare('SELECT id FROM releases WHERE id = ?').bind(input.release).first();
    if (!release) throw new UserError('找不到所选作品');
  }

  const summary = uploadSummary(input.batchDir);
  const batch = await db
    .prepare('SELECT actor, summary, max(reverted_by_batch) AS reverted FROM revisions WHERE batch_id = ?')
    .bind(input.batch)
    .first<{ actor: string | null; summary: string | null; reverted: string | null }>();
  if (batch?.actor && (batch.actor !== actor || batch.summary !== summary)) throw new UserError('上传批次与当前页面不符，请刷新页面');
  if (batch?.reverted) throw new UserError('这批上传已被撤销，请刷新页面重新开始');

  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const kept = [input.folder ?? '', ...dirs.map((d) => d.slice(0, 200))].filter(Boolean).join('/');
  const suggest = input.place
    ? JSON.stringify({ rule: N_('上传时指定'), confidence: 1, place: input.place, ...(kept ? { folder: kept } : {}), ...(input.place.startsWith('rel:') || input.place.startsWith('ed:') ? { rights: 'own' } : {}) })
    : input.release
      ? JSON.stringify({ rule: N_('上传时指定'), confidence: 1, release_id: input.release, rights: 'own', ...(input.slot ? { slot: input.slot } : {}) })
      : null;
  const id = newFileId();
  const cs = new ChangeSet(db, actor, summary, input.batch);
  const row: Record<string, unknown> = {
    id, origin: 'upload', dir: [input.batchDir, ...dirs].join('/'), name, ext, size: input.size, mtime: input.mtime,
    sha256: input.sha256, blob_key: key, kind: kindFor(ext), rights: 'unknown', state: 'inbox', suggest,
    note: input.note, uploaded_by: actor, sealed: keptWhole(kindFor(ext), ext) ? 1 : 0,
  };
  let renamed: string | null = null;
  // A place chosen on the upload page (the 版本页's 「上传到本版…」 chooses its edition) is where the file goes
  // at once, with the folders asked for, in the same batch; the suggestion stays as the record of it.
  if (input.place) {
    const places = await Places.load();
    const at = suggestedPlace(cs, places, JSON.parse(suggest!));
    if (at) {
      const place = places.place(at);
      Object.assign(row, placePatch({ state: 'inbox', rights: 'unknown', release_id: null, track_id: null }, place));
      markEditionsCollected(cs, places, [place.edition_id]);
      // A file of the same name there already: both are kept, the new one as «name (2).ext» (as cloud drives do).
      const free = await freeFileName(place.folder_id, name);
      if (free !== name) row.download_name = renamed = free;
    }
  }
  cs.create('file', row);
  // Records of this content that never had it stored (合辑 files imported without their bytes) get it too.
  cs.push(fillMissing(db, input.sha256, input.size));
  await cs.commit();
  return { id, renamed };
}

/** Every record of this content that has no stored copy yet points at the one now stored (a machine column, as `ra push` sets it). */
function fillMissing(db: D1Database, sha256: string, size: number): D1PreparedStatement {
  return db.prepare('UPDATE files SET blob_key = ?1 WHERE sha256 = ?2 AND blob_key IS NULL AND size = ?3').bind(blobKey(sha256), sha256, size);
}

/**
 * 「补传内容」 on a file's page: a record whose content was never stored (a 合辑 file imported without its bytes)
 * gets it from the original chosen in the browser. The browser hashed the file and stored it under
 * blobs/<sha256> (a whole file is checked by storage as it is stored); here the stored copy must exist with
 * the record's size. Every record of that content gets it. Returns how many records now have it.
 */
export async function restoreContent(db: D1Database, media: R2Bucket, actor: string, input: { file: string; sha256: string; size: number }): Promise<number> {
  if (!SHA256_HEX.test(input.sha256)) throw new UserError('SHA-256 无效');
  const row = await db.prepare('SELECT sha256, size, blob_key FROM files WHERE id = ?').bind(input.file).first<{ sha256: string | null; size: number; blob_key: string | null }>();
  if (!row) throw new UserError('找不到这个文件');
  if (row.blob_key) throw new UserError('这个文件的内容已经存好了');
  if (row.sha256 !== input.sha256 || row.size !== input.size) {
    throw new UserError('选的文件和这条记录的内容不一样（SHA-256 不符），不能补传。要换成别的文件，请在补传后用「上传新版本」。');
  }
  const object = await media.head(blobKey(input.sha256));
  if (!object || object.size !== input.size) throw new UserError('存储里还没有这个文件，请重新上传');
  const n = await db
    .prepare('SELECT count(*) AS n FROM files WHERE sha256 = ? AND blob_key IS NULL AND size = ?')
    .bind(input.sha256, input.size)
    .first<{ n: number }>();
  // Through a change set for its new catalogue version: public pages showing the file get its link at once.
  // (blob_key is a machine column: no history entry, as when `ra push` stores content.)
  const cs = new ChangeSet(db, actor, '');
  cs.push(fillMissing(db, input.sha256, input.size));
  await cs.commit();
  return n?.n ?? 0;
}

export const REPLACED_DIR = `${UPLOAD_ROOT}/替换的新版本`;

/**
 * 「上传新版本」: a new file that takes over the old one's place (release, slot, track, role, rights).
 * The old file keeps everything and is shown as an older version; undo removes the new one.
 */
export async function replaceFile(
  db: D1Database, media: R2Bucket, actor: string,
  input: { old: string; sha256: string; size: number; name: string; mtime: string | null },
): Promise<string> {
  if (!SHA256_HEX.test(input.sha256)) throw new UserError('SHA-256 无效');
  const { name } = splitPath(input.name);
  const old = await db.prepare('SELECT * FROM files WHERE id = ?').bind(input.old).first<Record<string, unknown>>();
  if (!old) throw new UserError('找不到要替换的文件');
  if (old.sha256 === input.sha256) throw new UserError('新文件与原文件内容完全相同');
  const newer = await db.prepare('SELECT id FROM files WHERE replaces = ?').bind(input.old).first<{ id: string }>();
  if (newer) throw new UserError('这个文件已经有新版本了，请在最新版本上操作');
  const object = await media.head(blobKey(input.sha256));
  if (!object || object.size !== input.size) throw new UserError('存储里还没有这个文件，请重新上传');

  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const id = newFileId();
  const cs = new ChangeSet(db, actor, summary('文件 {old}：上传新版本 {name}', { old: String(old.name), name: String(name) }));
  cs.create('file', {
    id, origin: 'upload', dir: REPLACED_DIR, name, ext, size: input.size, mtime: input.mtime, sha256: input.sha256,
    blob_key: blobKey(input.sha256), kind: kindFor(ext), rights: old.rights, release_id: old.release_id, slot: old.slot,
    edition_id: old.edition_id, folder_id: old.folder_id, track_id: old.track_id, role: old.role, download_name: null,
    // A published file's replacement is checked before it goes public again.
    state: old.state === 'published' ? 'classified' : old.state,
    note: `替换 ${old.name}`, uploaded_by: actor, replaces: old.id,
  });
  await cs.commit();
  return id;
}
