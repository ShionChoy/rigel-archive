import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveObject } from '../../lib/api';
import { checkAddress } from '../../lib/public/media';

/**
 * The public site's stored files, at the signed addresses its pages hand out (lib/public/media.ts):
 * /media/i/<epoch>/<sig>/<key> for pictures, /media/s/<epoch>/<exp>/<sig>/<key> for sound, video and text.
 * Requests sent from other sites' pages (Referer) are refused, so the files cannot be embedded elsewhere.
 */
const TYPES: Record<string, string> = { flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', webp: 'image/webp', jpg: 'image/jpeg', json: 'application/json' };

/**
 * Pictures (lasting addresses) are kept in the edge cache under their stored key, after the address has been
 * checked: a visitor far from the storage (Asia-Pacific) gets them from the nearest Cloudflare data centre once
 * someone there has seen them, and a picture the site has closed is still refused by its address. Sound and
 * video stream from storage (ranges, large files). The Cache API works on the site's domain, not workers.dev.
 */
const EDGE_LIMIT = 25 * 1048576;

const handler: APIRoute = async ({ request, params, url, locals }) => {
  const referer = request.headers.get('referer');
  if (referer) {
    let origin = '';
    try {
      origin = new URL(referer).origin;
    } catch {
      // unreadable: treated as another site's
    }
    if (origin !== url.origin) return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const checked = await checkAddress(params.path ?? '');
  if ('error' in checked) {
    // 410 tells the player to ask for a new address (scripts/player.ts); anything else is simply not here.
    // A picture of an older media epoch is gone for good: its page is made again with new addresses.
    return checked.error === 'expired' && !checked.lasting
      ? new Response('Expired', { status: 410, headers: { 'cache-control': 'no-store' } })
      : new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const cache = checked.lasting && request.method === 'GET' && !request.headers.has('range') ? (globalThis as { caches?: { default?: Cache } }).caches?.default : undefined;
  const cacheKey = new Request(`${url.origin}/media/cached/${checked.key}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const response = await serveObject(env.MEDIA, checked.key, request);
  if (response.status >= 400) return response;
  const headers = new Headers(response.headers);
  // Derived files may be stored without a type; players and browsers like to be told.
  if (!headers.get('content-type')) headers.set('content-type', TYPES[checked.key.split('.').pop() ?? ''] ?? 'application/octet-stream');
  headers.set(
    'cache-control',
    checked.lasting ? 'public, max-age=31536000, immutable' : `private, max-age=${Math.max(0, (checked.expires ?? 0) - Math.floor(Date.now() / 1000))}`,
  );
  headers.set('cross-origin-resource-policy', 'same-origin');
  const out = new Response(response.body, { status: response.status, headers });
  if (cache && out.status === 200 && Number(headers.get('content-length')) <= EDGE_LIMIT && locals.cfContext) {
    locals.cfContext.waitUntil(cache.put(cacheKey, out.clone()).catch(() => {}));
  }
  return out;
};

export const GET = handler;
export const HEAD = handler;
