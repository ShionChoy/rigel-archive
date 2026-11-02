import type { APIRoute } from 'astro';
import { json } from '../../lib/api';
import { publicDb } from '../../lib/db';
import { siteLangFromHeader, translator, type SiteLang } from '../../lib/i18n';
import { catalogueVersion } from '../../lib/public/cache';
import { randomQueue } from '../../lib/public/catalog';
import { publicUrls } from '../../lib/public/media';

// Picking a queue reads every playable track (about 20,000 rows), so a few queues per language are kept at the edge
// for a minute and each visit gets one of them by chance: a burst of visits, or of requests made to run up the
// bill, picks at most SLOTS queues per language a minute in each data centre, and pressing 随机播放 again still
// mostly brings another queue. The queues' addresses are good for two hours (lib/public/media.ts), and the
// catalogue's version is in the key, so a work taken down leaves the queues at once (lib/public/cache.ts).
const KEEP = 60;
const SLOTS = 4;

/** A queue of random public tracks (首页 「随机播放」): /api/random?lang=<the page's html lang>. */
export const GET: APIRoute = async ({ url, request, locals }) => {
  const asked = (url.searchParams.get('lang') ?? '').toLowerCase();
  const lang: SiteLang = asked.startsWith('ja') ? 'ja' : asked.startsWith('en') ? 'en' : asked.startsWith('zh') ? 'zh' : siteLangFromHeader(request.headers.get('accept-language'));

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cf = locals.cfContext;
  const edge = !import.meta.env.DEV && cache && cf ? cache : null;
  const key = edge && new Request(`${url.origin}/api/random?lang=${lang}&slot=${Math.floor(Math.random() * SLOTS)}&_v=${await catalogueVersion()}`);
  const hit = edge && key ? await edge.match(key) : undefined;
  if (hit) {
    const served = new Response(hit.body, hit);
    served.headers.set('cache-control', 'no-store');
    return served;
  }

  const urls = await publicUrls();
  const lines = urls ? await randomQueue(publicDb(), { t: translator(lang), lang, urls }) : [];
  const response = json(lines.map(({ file, title, sub, album, cover, href, sources, exp }) => ({ file, title, sub, album, cover, href, sources, exp })));
  if (edge && key && cf && lines.length) {
    const kept = new Response(response.clone().body, response);
    kept.headers.set('cache-control', `public, max-age=0, s-maxage=${KEEP}`);
    cf.waitUntil(edge.put(key, kept));
  }
  // Browsers ask again every time; the copy kept at the edge is the one above.
  response.headers.set('cache-control', 'no-store');
  return response;
};
