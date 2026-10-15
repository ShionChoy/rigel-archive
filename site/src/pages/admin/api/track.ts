import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../../lib/api';
import { db } from '../../../lib/db';
import { adminUrls } from '../../../lib/media';
import { trackInfo, type InfoFile } from '../../../lib/track-info';

/** What 正在播放 shows of a track in the admin's 预览公开页 (lib/track-info.ts): /admin/api/track?f=<file id>. */
export const GET: APIRoute = async ({ url, locals }) => {
  const fileId = url.searchParams.get('f') ?? '';
  const database = db();
  const file = /^[\w-]{1,80}$/.test(fileId)
    ? await database.prepare("SELECT id, edition_id, folder_id, track_id, sha256, name, download_name, ext FROM files WHERE id = ? AND kind = 'audio'").bind(fileId).first<InfoFile>()
    : null;
  if (!file) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } });
  return json(await trackInfo(database, env.MEDIA, file, { t: locals.t, urls: adminUrls(env.MEDIA_DEV_BASE ?? ''), fileOk: '1 = 1' }));
};
