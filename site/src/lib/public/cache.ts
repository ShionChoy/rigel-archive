// Public pages kept at the edge (设计文档「公开站方案 · 技术」): each page is cached under its address plus
// the catalogue's version, which every saved change in the admin counts up (ChangeSet.commit), so a change
// shows at once and pages nobody changed stay cached; and plus the build, since a page cached before a
// deployment names script and style files the new one no longer has.
//
// A page counts as current for FRESH seconds and stays in the cache for KEEP. A visit after FRESH gets the kept
// page at once while it is rendered anew behind it (stale-while-revalidate): an uncached page takes a far-away
// visitor a second or more (each query crosses to the nearest copy of the database), so visitors seldom wait
// for one. Re-rendering is also how what the processing program adds (stream files, previews) shows up without
// an admin saving anything. KEEP stays below the two hours a page's signed addresses are good for
// (lib/public/media.ts), so a served page's addresses never run out.
//
// Browsers are told to check again on every visit (max-age=0): Cloudflare would otherwise hand pages from the
// cache out with its own browser lifetime (4 hours by default), and a change or a deployment would not reach them.
//
// The Cache API keeps entries per Cloudflare data centre, and only on the site's own domain (not workers.dev).

import { publicDb } from '../db';

const FRESH = 600;
const KEEP = 3600;
/** When a kept page was rendered (ms), on the cached copy only. */
const RENDERED = 'x-rendered-at';
const BROWSER = 'public, max-age=0';
/** Pages being rendered anew in this Worker instance: a burst of visits renders a stale page once. */
const renewing = new Set<string>();

/** meta.public_version, read at most every few seconds per Worker instance. */
let known: { value: string; at: number } | null = null;

export async function catalogueVersion(): Promise<string> {
  if (known && Date.now() - known.at < 5000) return known.value;
  const row = await publicDb().prepare("SELECT value FROM meta WHERE key = 'public_version'").first<{ value: string }>();
  known = { value: row?.value ?? '0', at: Date.now() };
  return known.value;
}

const keepable = (response: Response) => response.status === 200 && !response.headers.has('set-cookie');

/** The copy that goes into the cache: kept for KEEP seconds, stamped with its time. */
function stamped(response: Response): Response {
  response.headers.set('cache-control', `public, max-age=0, s-maxage=${KEEP}`);
  response.headers.set(RENDERED, String(Date.now()));
  return response;
}

/** Serve a public GET page from the edge cache, or render it and keep it there; a stale one is renewed behind it. */
export async function cachedPage(request: Request, url: URL, waitUntil: ((p: Promise<unknown>) => void) | undefined, render: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (import.meta.env.DEV || request.method !== 'GET' || !cache || !waitUntil) return render();
  const key = new Request(`${url.origin}${url.pathname}?${new URLSearchParams([...url.searchParams, ['_v', await catalogueVersion()], ['_b', __BUILD_ID__]])}`);
  const hit = await cache.match(key);
  if (hit) {
    if (Date.now() - Number(hit.headers.get(RENDERED) || 0) > FRESH * 1000 && !renewing.has(key.url)) {
      renewing.add(key.url);
      const renew = async () => {
        const fresh = await render();
        if (keepable(fresh)) await cache.put(key, stamped(fresh));
        else await fresh.body?.cancel();
      };
      waitUntil(renew().catch(() => {}).finally(() => renewing.delete(key.url)));
    }
    const served = new Response(hit.body, hit);
    served.headers.set('cache-control', BROWSER);
    served.headers.delete(RENDERED);
    return served;
  }
  const response = await render();
  if (keepable(response)) {
    response.headers.set('cache-control', BROWSER);
    waitUntil(cache.put(key, stamped(response.clone())));
  }
  return response;
}
