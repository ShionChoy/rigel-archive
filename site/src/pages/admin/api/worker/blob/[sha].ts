import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, blobKey, fail, serveObject } from '../../../../../lib/api';
import { putBlob } from '../../../../../lib/blobs';

// `ra worker` reads uploads back through GET; `ra push` and `ra worker` store content through PUT.

const read: APIRoute = async ({ request, params }) => {
  const sha256 = params.sha ?? '';
  if (!SHA256_HEX.test(sha256)) return fail('SHA-256 无效');
  return serveObject(env.MEDIA, blobKey(sha256), request);
};

export const GET = read;
export const HEAD = read;

export const PUT: APIRoute = async ({ request, params }) => putBlob(env.MEDIA, params.sha ?? '', request);
