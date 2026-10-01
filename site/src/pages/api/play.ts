import type { APIRoute } from 'astro';
import { json } from '../../lib/api';
import { db } from '../../lib/db';
import { playSources } from '../../lib/public/catalog';
import { publicUrls } from '../../lib/public/media';

/** New addresses for a public track whose old ones ran out (scripts/player.ts): /api/play?f=<file id>. */
export const GET: APIRoute = async ({ url }) => {
  const urls = publicUrls();
  const fileId = url.searchParams.get('f') ?? '';
  const found = urls && /^[\w-]{1,80}$/.test(fileId) ? await playSources(db(), fileId, urls) : null;
  if (!found) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  const response = json(found);
  response.headers.set('cache-control', 'private, max-age=300');
  return response;
};
