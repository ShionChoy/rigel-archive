import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, blobKey, fail, serveObject } from '../../../../../lib/api';
import { putBlob } from '../../../../../lib/blobs';

// `ra worker` reads contents back through GET (uploads to check, originals to derive); `ra push` and
// `ra worker` store content through PUT. A picture carried inside audio files (pictures/<sha256>) is read
// the same way, to make its previews (lib/processing.ts WANTED_PICTURES).

const read: APIRoute = async ({ request, params }) => {
  const sha256 = params.sha ?? '';
  if (!SHA256_HEX.test(sha256)) return fail('SHA-256 无效');
  const blob = await serveObject(env.MEDIA, blobKey(sha256), request);
  return blob.status === 404 ? serveObject(env.MEDIA, `pictures/${sha256}`, request) : blob;
};

export const GET = read;
export const HEAD = read;

export const PUT: APIRoute = async ({ request, params }) => putBlob(env.MEDIA, params.sha ?? '', request);
