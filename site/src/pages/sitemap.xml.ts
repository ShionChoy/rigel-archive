import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { publicDb } from '../lib/db';
import { HTML_LANG, SITE_LANGS } from '../lib/i18n';
import { pagesFor } from '../lib/public/paths';
import { PUBLIC_RELEASE } from '../lib/public/rules';
import { SITE } from '../lib/site';

type Page = (pages: ReturnType<typeof pagesFor>) => string;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * The public pages for search engines (named in robots.txt): the home, works and about pages and every published
 * work, each in its three languages with the others as alternates. Song pages are found through the works.
 */
export const GET: APIRoute = async ({ url }) => {
  if (SITE.noindex || (url.hostname !== env.PUBLIC_HOST && !import.meta.env.DEV)) return new Response('Not found', { status: 404 });
  const { results } = await publicDb().prepare(`SELECT r.id FROM releases r WHERE ${PUBLIC_RELEASE} ORDER BY r.release_date DESC, r.id`).all<{ id: string }>();
  const pages: Page[] = [(p) => p.home, (p) => p.works(), (p) => p.about, ...results.map((r): Page => (p) => p.work(r.id))];
  const address = (page: Page, lang: (typeof SITE_LANGS)[number]) => esc(url.origin + page(pagesFor(lang)));
  const entries = pages.flatMap((page) =>
    SITE_LANGS.map((lang) => `  <url><loc>${address(page, lang)}</loc>${SITE_LANGS.map((l) => `<xhtml:link rel="alternate" hreflang="${HTML_LANG[l]}" href="${address(page, l)}"/>`).join('')}</url>`),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
};
