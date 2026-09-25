import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, blobKey, fail, fromAdminPage, json, readJson } from '../../../../lib/api';

/** Before uploading: is the content already stored, and which files already have it? */
export const POST: APIRoute = async ({ request, url, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  const body = await readJson(request).catch(() => null);
  const sha256 = String(body?.sha256 ?? '');
  if (!SHA256_HEX.test(sha256)) return fail(locals.t('SHA-256 无效'));
  const [object, files] = await Promise.all([
    env.MEDIA.head(blobKey(sha256)),
    env.DB.prepare('SELECT id, dir, name FROM files WHERE sha256 = ? ORDER BY origin, dir, name LIMIT 5')
      .bind(sha256)
      .all<{ id: string; dir: string; name: string }>(),
  ]);
  return json({ stored: object !== null, size: object?.size ?? null, files: files.results });
};
