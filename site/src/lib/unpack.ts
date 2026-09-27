// Archives uploaded in the admin are unpacked by `ra worker`, which stores each member's content and
// then registers the members here. Members join the upload's revision batch, so undoing the upload
// removes them together with the archive.

import { SHA256_HEX, blobKey } from './api';
import { ChangeSet } from './changes';
import { kindFor } from './constants';
import { N_, summary, UserError } from './i18n';

export interface MemberInput {
  path: string; // inside the uploaded archive; members of inner archives use "inner.zip!/file"
  parent: string; // '' for the uploaded archive itself, else the path of the inner archive
  size: number;
  mtime: string | null;
  sha256: string | null; // null when it could not be unpacked (encrypted, damaged)
  note: string | null;
  format: Record<string, unknown> | null;
  pcm_md5: string | null;
}

// Same files the upload page skips and the import rules ignore.
const JUNK = /(^|\/)(__MACOSX\/|\._[^/]*$|(thumbs\.db|desktop\.ini|\.ds_store)$)/i;
const MAX_MEMBERS = 50_000;

function newFileId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `f_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function str(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  if (s.length > max) throw new UserError('内容过长');
  return s;
}

export function parseMembers(raw: unknown): MemberInput[] {
  if (!Array.isArray(raw)) throw new UserError('缺少包内文件列表');
  if (raw.length > MAX_MEMBERS) throw new Error(`包内文件超过 ${MAX_MEMBERS} 个`);
  const seen = new Set<string>(['']);
  return raw.map((item: Record<string, unknown>) => {
    const path = String(item.path ?? '');
    const parent = String(item.parent ?? '');
    const parts = path.split('!/').flatMap((p) => p.split('/'));
    if (!path || path.length > 1000 || parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`包内路径无效：${path}`);
    if (!seen.has(parent) || (parent && !path.startsWith(`${parent}!/`))) throw new Error(`包内文件的上级不对：${path}`);
    seen.add(path);
    const sha256 = str(item.sha256, 64);
    if (sha256 && !SHA256_HEX.test(sha256)) throw new Error(`SHA-256 无效：${path}`);
    const size = Number(item.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`文件大小无效：${path}`);
    const mtime = str(item.mtime, 40);
    const pcm = str(item.pcm_md5, 32);
    return {
      path, parent, size, sha256,
      mtime: mtime && !Number.isNaN(Date.parse(mtime)) ? mtime : null,
      note: str(item.note, 500),
      format: item.format && typeof item.format === 'object' ? (item.format as Record<string, unknown>) : null,
      pcm_md5: pcm && /^[0-9a-f]{32}$/.test(pcm) ? pcm : null,
    };
  });
}

interface ArchiveRow {
  id: string;
  dir: string;
  name: string;
  suggest: string | null;
  uploaded_by: string | null;
  sealed: number;
}

/** Rows for the members of one uploaded archive, parents before their members. */
export function memberRows(archive: ArchiveRow, members: MemberInput[], now: string): Record<string, unknown>[] {
  const ids = new Map<string, string>([['', archive.id]]);
  const base = archive.dir ? `${archive.dir}/${archive.name}` : archive.name;
  const inherited = archive.suggest ? { ...JSON.parse(archive.suggest), rule: N_('上传时指定（包内文件）') } : null;
  return members.map((m) => {
    const id = newFileId();
    ids.set(m.path, id);
    const full = `${base}/${m.path.replaceAll('!/', '/')}`;
    const cut = full.lastIndexOf('/');
    const name = full.slice(cut + 1);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const junk = JUNK.test(m.path.replaceAll('!/', '/'));
    const suggest = junk ? { rule: N_('系统生成的文件'), confidence: 1, state: 'ignored' } : inherited;
    return {
      id, origin: 'upload', dir: full.slice(0, cut), member_of: ids.get(m.parent), member_path: m.path, name, ext,
      size: m.size, mtime: m.mtime, sha256: m.sha256, blob_key: m.sha256 ? blobKey(m.sha256) : null, kind: kindFor(ext),
      format: m.format ? JSON.stringify(m.format) : null, pcm_md5: m.pcm_md5, rights: 'unknown', state: 'inbox',
      suggest: suggest ? JSON.stringify(suggest) : null, note: m.note, uploaded_by: archive.uploaded_by, checked_at: now,
      // An archive uploaded to be kept whole: its members are listed, not organized one by one.
      sealed_in: archive.sealed ? archive.id : null,
    };
  });
}

/**
 * Register the members of every uploaded archive with this content that has none yet (the same
 * archive may have been uploaded twice). Returns how many archives got members.
 */
export async function registerMembers(db: D1Database, actor: string, sha256: string, members: MemberInput[]): Promise<number> {
  const { results: archives } = await db
    .prepare(
      `SELECT id, dir, name, suggest, uploaded_by, sealed FROM files a
       WHERE sha256 = ? AND origin = 'upload' AND member_of IS NULL
         AND NOT EXISTS (SELECT 1 FROM files m WHERE m.member_of = a.id)`,
    )
    .bind(sha256)
    .all<ArchiveRow>();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  let done = 0;
  for (const archive of archives) {
    const batch = await db
      .prepare(
        `SELECT batch_id, summary FROM revisions WHERE entity = 'file' AND entity_id = ? AND action = 'create'
         AND reverted_by_batch IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .bind(archive.id)
      .first<{ batch_id: string; summary: string }>();
    const cs = new ChangeSet(db, actor, batch?.summary ?? summary('解开上传的压缩包 {name}', { name: archive.name }), batch?.batch_id);
    cs.createFiles(memberRows(archive, members, now));
    await cs.commit();
    done += 1;
  }
  return done;
}
