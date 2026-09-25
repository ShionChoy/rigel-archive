import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json } from '../../../../lib/api';

/** One page of stored objects under blobs/ or derived/ (the backup compares them with B2). */
export const GET: APIRoute = async ({ url }) => {
  const prefix = url.searchParams.get('prefix') ?? '';
  if (prefix !== 'blobs/' && prefix !== 'derived/') return fail('prefix 只能是 blobs/ 或 derived/');
  const page = await env.MEDIA.list({ prefix, cursor: url.searchParams.get('cursor') || undefined, limit: 1000 });
  return json({
    objects: page.objects.map((o) => ({ key: o.key, size: o.size })),
    cursor: page.truncated ? page.cursor : null,
  });
};
