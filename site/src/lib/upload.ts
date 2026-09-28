// Registering files uploaded from the admin (/admin/upload). The browser has already hashed the file
// and put its bytes in storage under blobs/<sha256>; this adds the file to the 整理台.

import { SHA256_HEX, blobKey } from './api';
import { ChangeSet } from './changes';
import { SLOTS, UPLOAD_ROOT, isOneOf, kindFor } from './constants';
import { N_, summary, UserError } from './i18n';
import { newId } from './ids';

export interface UploadInput {
  batch: string; // one upload session = one revision batch, undone together
  batchDir: string; // 后台上传/<session>
  path: string; // relative path from the upload page ("folder/file.flac")
  size: number;
  mtime: string | null;
  sha256: string;
  release: string | null;
  slot: string | null;
  place: string | null; // era:/rel:/ed:/fd: key chosen on the upload page
  keep: boolean; // the uploaded folders come along below the place
  folder: string | null; // a new folder under the place, chosen in the picker
  sealed: boolean; // archives are kept whole
  note: string | null;
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
  if (slot && !isOneOf(SLOTS, slot)) throw new UserError('未知的版本栏位');
  const release = text(body.release, 100);
  if (slot && !release) throw new UserError('选择版本栏位前要先选作品');
  const place = text(body.place, 80);
  if (place && !/^((era|rel|ed|fd):[\w-]{1,80}|top)$/.test(place)) throw new UserError('找不到这个位置');
  return {
    batch, batchDir, sha256, size, slot, release, place, keep: body.keep === true, sealed: body.sealed === true,
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

export async function registerUpload(db: D1Database, media: R2Bucket, actor: string, input: UploadInput): Promise<string> {
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
  // A place chosen on the upload page is a suggestion with full confidence: 「按建议确认」 files it.
  const kept = [input.folder ?? '', ...(input.keep ? dirs.map((d) => d.slice(0, 200)) : [])].filter(Boolean).join('/');
  const suggest = input.place
    ? JSON.stringify({ rule: N_('上传时指定'), confidence: 1, place: input.place, ...(kept ? { folder: kept } : {}), ...(input.place.startsWith('rel:') || input.place.startsWith('ed:') ? { rights: 'own' } : {}) })
    : input.release
      ? JSON.stringify({ rule: N_('上传时指定'), confidence: 1, release_id: input.release, rights: 'own', ...(input.slot ? { slot: input.slot } : {}) })
      : null;
  const archive = ['archive', 'disc_image'].includes(kindFor(name.slice(name.lastIndexOf('.') + 1)));
  const id = newFileId();
  const cs = new ChangeSet(db, actor, summary, input.batch);
  cs.create('file', {
    id, origin: 'upload', dir: [input.batchDir, ...dirs].join('/'), name, ext, size: input.size, mtime: input.mtime,
    sha256: input.sha256, blob_key: key, kind: kindFor(ext), rights: 'unknown', state: 'inbox', suggest,
    note: input.note, uploaded_by: actor, sealed: input.sealed && archive ? 1 : 0,
  });
  await cs.commit();
  return id;
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
