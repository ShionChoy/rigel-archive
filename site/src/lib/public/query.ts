// The query parameters each public page reads (设计文档「公开站方案 · 页面与网址」), and what a value must look like.
//
// Public pages are kept at the edge under their address (lib/public/cache.ts). An address with anything else in its
// query (?x=<random>, utm_… or fbclid from a shared link, a parameter twice, an empty one) is sent on to the same
// address without it, before anything is read from the database: otherwise every such address would be rendered
// anew, and the page kept for it would carry the stray parameters in its own links (the canonical link and the
// language links repeat the address's query).
//
// A value that is well-formed but names nothing (?form=<random>) still renders a page of its own; the values are
// checked only for their shape here, without the database.

const NAME = (value: string) => value.trim() !== '' && value.length <= 100;

const PAGES: [RegExp, Record<string, (value: string) => boolean>][] = [
  // 作品库: grid or timeline, filtered by 名义 (era id), 形式 (form id), series and year.
  [/^\/[a-z]{2}\/works\/?$/, { view: (v) => v === 'timeline', era: NAME, form: NAME, series: NAME, year: (v) => /^\d{4}$/.test(v) }],
  // A work: one of its editions, or 版本对照.
  [/^\/[a-z]{2}\/works\/[^/]+\/?$/, { edition: NAME, view: (v) => v === 'compare' }],
];

/** Where to send a public page's address that has query parameters the page does not read; null when it has none. */
export function withoutStrayParams(url: URL): string | null {
  if (!url.search) return null;
  const allowed = PAGES.find(([path]) => path.test(url.pathname))?.[1] ?? {};
  // An empty piece (?&, a trailing &) is not a parameter, but it would still be repeated in the page's links.
  let stray = url.search.slice(1).split('&').some((piece) => piece === '');
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(allowed, key) && !kept.has(key) && allowed[key](value)) kept.append(key, value);
    else stray = true;
  }
  if (!stray) return null;
  // Built from the kept parameters alone, so the address sent to is never sent on again.
  const query = kept.toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}
