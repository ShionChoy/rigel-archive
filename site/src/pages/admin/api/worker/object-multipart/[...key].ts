import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail } from '../../../../../lib/api';
import { DERIVED_KEY, multipartActionAt, uploadPartAt } from '../../../../../lib/blobs';

// Large derived files (long videos, hi-res stream FLACs) in parts, like large uploads.

export const POST: APIRoute = async ({ request, params }) => {
  const key = params.key ?? '';
  if (!DERIVED_KEY.test(key)) return fail('衍生文件位置无效');
  return multipartActionAt(env.MEDIA, key, request);
};

export const PUT: APIRoute = async ({ request, url, params }) => {
  const key = params.key ?? '';
  if (!DERIVED_KEY.test(key)) return fail('衍生文件位置无效');
  return uploadPartAt(env.MEDIA, key, url, request);
};
