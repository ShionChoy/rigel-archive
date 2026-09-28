import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveObject } from '../../../lib/api';

/** Stored content for admin previews: /admin/media/blobs/<sha256>[?download=<name>]. */
const handler: APIRoute = async ({ request, params, url }) => {
  const key = params.key ?? '';
  if (!/^(blobs|derived|pictures)\/[\w./-]+$/.test(key) || key.includes('..')) return new Response('找不到文件', { status: 404 });
  return serveObject(env.MEDIA, key, request, url.searchParams.get('download') ?? undefined);
};

export const GET = handler;
export const HEAD = handler;
