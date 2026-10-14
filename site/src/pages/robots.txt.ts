import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SITE } from '../lib/site';

/**
 * robots.txt. On the public site's host, search engines may read the pages (unless SITE.noindex) but not the
 * player's API or the sound, video and text addresses (they run out anyway); pictures stay open for image
 * search and link previews; the pages are listed in sitemap.xml. Any other host is closed to them (the
 * admin's is behind Cloudflare Access too).
 */
export const GET: APIRoute = ({ url }) => {
  const open = !SITE.noindex && url.hostname === env.PUBLIC_HOST;
  const lines = open ? ['User-agent: *', 'Disallow: /api/', 'Disallow: /media/s/', '', `Sitemap: https://${env.PUBLIC_HOST}/sitemap.xml`] : ['User-agent: *', 'Disallow: /'];
  return new Response(`${lines.join('\n')}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
};
