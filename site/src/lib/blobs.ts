// Storing content in R2. Originals go under blobs/<sha256> (shared by the upload page, /admin/api/upload/*,
// and by `ra push` / `ra worker`, /admin/api/worker/*, which differ only in how the caller is checked);
// files the processing program makes from them go under derived/ (see DERIVED_KEY).

import { SHA256_HEX, blobKey, fail, json, readJson } from './api';
import { translator, type T } from './i18n';

/** Largest file sent in one request; bigger ones go in parts of this size (Workers accept 100 MB). */
export const PART_SIZE = 50 * 1024 * 1024;

const ZH = translator('zh');

/**
 * Keys of derived files: derived/<kind>/<original's sha256>.<ext> or derived/<kind>/<sha256>/<name>,
 * e.g. derived/stream/…flac, derived/img/…/640.webp, derived/video/…/720p.mp4.
 */
export const DERIVED_KEY = /^derived\/[a-z0-9]+\/[0-9a-f]{64}(\.[a-z0-9]+|\/[a-z0-9][\w.-]*)$/;

/** Store a whole file. With a SHA-256, R2 checks it as it stores, so what is stored is what was hashed. */
export async function putObject(media: R2Bucket, key: string, request: Request, sha256: string | null, t: T = ZH): Promise<Response> {
  if (!request.body) return fail(t('没有文件内容'));
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > PART_SIZE + 1024) return fail(t('文件太大，请分块上传'), 413);
  try {
    const object = await media.put(key, request.body, {
      ...(sha256 ? { sha256 } : {}),
      httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' },
    });
    return json({ size: object?.size ?? null });
  } catch (e) {
    return fail(t('存储拒绝了这个文件（内容与 SHA-256 不符？）：{error}', { error: e instanceof Error ? e.message : String(e) }));
  }
}

export async function putBlob(media: R2Bucket, sha256: string, request: Request, t: T = ZH): Promise<Response> {
  if (!SHA256_HEX.test(sha256)) return fail(t('SHA-256 无效'));
  return putObject(media, blobKey(sha256), request, sha256, t);
}

/**
 * create / complete / abort a multipart upload. R2 does not check the SHA-256 of an object assembled
 * from parts; `ra worker` reads uploads back and checks them, and `ra push` hashes as it reads.
 */
export async function multipartActionAt(media: R2Bucket, key: string, request: Request, t: T = ZH): Promise<Response> {
  try {
    const body = await readJson(request);
    switch (body.action) {
      case 'create': {
        const upload = await media.createMultipartUpload(key, {
          httpMetadata: { contentType: String(body.contentType ?? '') || 'application/octet-stream' },
        });
        return json({ uploadId: upload.uploadId });
      }
      case 'complete': {
        const parts = Array.isArray(body.parts) ? (body.parts as R2UploadedPart[]) : [];
        if (parts.length === 0) return fail(t('没有已上传的分块'));
        const object = await media.resumeMultipartUpload(key, String(body.uploadId)).complete(parts);
        return json({ size: object.size });
      }
      case 'abort':
        await media.resumeMultipartUpload(key, String(body.uploadId)).abort();
        return json({ ok: true });
      default:
        return fail(t('未知的操作'));
    }
  } catch (e) {
    return fail(t(e instanceof Error ? e.message : String(e)));
  }
}

export async function uploadPartAt(media: R2Bucket, key: string, url: URL, request: Request, t: T = ZH): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId') ?? '';
  const part = Number(url.searchParams.get('part'));
  if (!uploadId || !Number.isInteger(part) || part < 1 || part > 10000) return fail(t('参数无效'));
  if (!request.body) return fail(t('没有分块内容'));
  try {
    const uploaded = await media.resumeMultipartUpload(key, uploadId).uploadPart(part, request.body);
    return json(uploaded);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function multipartAction(media: R2Bucket, sha256: string, request: Request, t: T = ZH): Promise<Response> {
  if (!SHA256_HEX.test(sha256)) return fail(t('SHA-256 无效'));
  return multipartActionAt(media, blobKey(sha256), request, t);
}

export async function uploadPart(media: R2Bucket, sha256: string, url: URL, request: Request, t: T = ZH): Promise<Response> {
  if (!SHA256_HEX.test(sha256)) return fail(t('参数无效'));
  return uploadPartAt(media, blobKey(sha256), url, request, t);
}

/** Which of these contents are stored (sizes by SHA-256). At most 100 per call. */
export async function storedSizes(media: R2Bucket, shas: string[]): Promise<Map<string, number>> {
  const heads = await Promise.all(shas.map((s) => media.head(blobKey(s))));
  const out = new Map<string, number>();
  heads.forEach((h, i) => {
    if (h) out.set(shas[i], h.size);
  });
  return out;
}

/** A JSON list of SHA-256s from a request body, validated. */
export function shaList(body: Record<string, unknown>, max = 100): string[] {
  const list = Array.isArray(body.shas) ? body.shas.map(String) : [];
  if (list.length > max) throw new Error(`一次最多 ${max} 个`);
  if (!list.every((s) => SHA256_HEX.test(s))) throw new Error('SHA-256 无效');
  return [...new Set(list)];
}
