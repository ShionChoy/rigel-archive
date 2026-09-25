import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, fromAdminPage } from '../../../../../lib/api';
import { multipartAction, uploadPart } from '../../../../../lib/blobs';

// Large files are uploaded in parts (each well under the Workers request size limit).

export const POST: APIRoute = async ({ request, url, params, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  return multipartAction(env.MEDIA, params.sha ?? '', request, locals.t);
};

export const PUT: APIRoute = async ({ request, url, params, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  return uploadPart(env.MEDIA, params.sha ?? '', url, request, locals.t);
};
