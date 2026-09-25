import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, fail } from '../../../../../lib/api';
import { DERIVED_KEY, putObject } from '../../../../../lib/blobs';

/** Store a derived file (only under derived/); X-Content-Sha256 lets storage check the bytes. */
export const PUT: APIRoute = async ({ request, params }) => {
  const key = params.key ?? '';
  if (!DERIVED_KEY.test(key)) return fail('衍生文件位置无效');
  const sha256 = request.headers.get('x-content-sha256');
  return putObject(env.MEDIA, key, request, sha256 && SHA256_HEX.test(sha256) ? sha256 : null);
};
