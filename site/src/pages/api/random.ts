import type { APIRoute } from 'astro';
import { json } from '../../lib/api';
import { db } from '../../lib/db';
import { siteLangFromHeader, translator, type SiteLang } from '../../lib/i18n';
import { randomQueue } from '../../lib/public/catalog';
import { publicUrls } from '../../lib/public/media';

/** A queue of random public tracks (首页 「随机播放」): /api/random?lang=<the page's html lang>. */
export const GET: APIRoute = async ({ url, request }) => {
  const urls = await publicUrls();
  const asked = (url.searchParams.get('lang') ?? '').toLowerCase();
  const lang: SiteLang = asked.startsWith('ja') ? 'ja' : asked.startsWith('en') ? 'en' : asked.startsWith('zh') ? 'zh' : siteLangFromHeader(request.headers.get('accept-language'));
  const lines = urls ? await randomQueue(db(), { t: translator(lang), lang, urls }) : [];
  const response = json(lines.map(({ file, title, sub, album, cover, href, sources, exp }) => ({ file, title, sub, album, cover, href, sources, exp })));
  response.headers.set('cache-control', 'no-store');
  return response;
};
