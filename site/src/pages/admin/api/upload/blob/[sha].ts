import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, fromAdminPage } from '../../../../../lib/api';
import { putBlob } from '../../../../../lib/blobs';

/** Upload a whole file (up to the part size) in one request. */
export const PUT: APIRoute = async ({ request, url, params, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  return putBlob(env.MEDIA, params.sha ?? '', request, locals.t);
};
