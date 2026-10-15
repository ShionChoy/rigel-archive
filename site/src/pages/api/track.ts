import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../lib/api';
import { publicDb } from '../../lib/db';
import { siteLangFromHeader, translator, type SiteLang } from '../../lib/i18n';
import { publicUrls } from '../../lib/public/media';
import { OPEN_FILE, PUBLIC_EDITION, PUBLIC_RELEASE } from '../../lib/public/rules';
import { trackInfo, type InfoFile } from '../../lib/track-info';

/** What 正在播放 shows of a public track (lib/track-info.ts): /api/track?f=<file id>&lang=<the page's html lang>. */
export const GET: APIRoute = async ({ url, request }) => {
  const urls = await publicUrls();
  const fileId = url.searchParams.get('f') ?? '';
  const asked = (url.searchParams.get('lang') ?? '').toLowerCase();
  const lang: SiteLang = asked.startsWith('ja') ? 'ja' : asked.startsWith('en') ? 'en' : asked.startsWith('zh') ? 'zh' : siteLangFromHeader(request.headers.get('accept-language'));
  const database = publicDb();
  const file = urls && /^[\w-]{1,80}$/.test(fileId)
    ? await database
      .prepare(
        `SELECT f.id, f.edition_id, f.folder_id, f.track_id, f.sha256, f.name, f.download_name, f.ext
         FROM files f JOIN editions e ON e.id = f.edition_id JOIN releases r ON r.id = e.release_id
         WHERE f.id = ? AND f.kind = 'audio' AND ${OPEN_FILE} AND ${PUBLIC_EDITION} AND ${PUBLIC_RELEASE}`,
      )
      .bind(fileId)
      .first<InfoFile>()
    : null;
  if (!urls || !file) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  const response = json(await trackInfo(database, env.MEDIA, file, { t: translator(lang), urls, fileOk: OPEN_FILE }));
  response.headers.set('cache-control', 'private, max-age=300');
  return response;
};
