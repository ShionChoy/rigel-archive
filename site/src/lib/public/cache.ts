// Public pages kept at the edge (设计文档「公开站方案 · 技术」): each page is cached under its address plus
// the catalogue's version, which every saved change in the admin counts up (ChangeSet.commit), so a change
// shows at once and pages nobody changed stay cached; and plus the build, since a page cached before a
// deployment names script and style files the new one no longer has. Entries also expire after PAGE_TTL,
// so what the processing program adds (stream files, previews) shows up without an admin saving anything,
// and a cached page's signed addresses (good for two hours, lib/public/media.ts) never run out while it is served.
//
// The Cache API does nothing on workers.dev: this takes effect once the site has its own domain.

import { env } from 'cloudflare:workers';

const PAGE_TTL = 600;

/** meta.public_version, read at most every few seconds per Worker instance. */
let known: { value: string; at: number } | null = null;

export async function catalogueVersion(): Promise<string> {
  if (known && Date.now() - known.at < 5000) return known.value;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'public_version'").first<{ value: string }>();
  known = { value: row?.value ?? '0', at: Date.now() };
  return known.value;
}

/** Serve a public GET page from the edge cache, or render it and keep it there. */
export async function cachedPage(request: Request, url: URL, waitUntil: ((p: Promise<unknown>) => void) | undefined, render: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (import.meta.env.DEV || request.method !== 'GET' || !cache || !waitUntil) return render();
  const key = new Request(`${url.origin}${url.pathname}?${new URLSearchParams([...url.searchParams, ['_v', await catalogueVersion()], ['_b', __BUILD_ID__]])}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await render();
  if (response.status === 200 && !response.headers.has('set-cookie')) {
    response.headers.set('cache-control', `public, max-age=0, s-maxage=${PAGE_TTL}`);
    waitUntil(cache.put(key, response.clone()));
  }
  return response;
}
