import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, blobKey, fail, fromAdminPage, json, readJson } from '../../../../lib/api';

/**
 * Before uploading: is the content already stored? Then only the file's record is added (秒传). Files with the
 * same content are added all the same: an upload never skips a file.
 */
export const POST: APIRoute = async ({ request, url, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  const body = await readJson(request).catch(() => null);
  const sha256 = String(body?.sha256 ?? '');
  if (!SHA256_HEX.test(sha256)) return fail(locals.t('SHA-256 无效'));
  const object = await env.MEDIA.head(blobKey(sha256));
  return json({ stored: object !== null, size: object?.size ?? null });
};
