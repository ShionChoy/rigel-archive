import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveObject } from '../../../lib/api';
import { db, type FileRow } from '../../../lib/db';
import { taggedResponse, taggedSource } from '../../../lib/tags';

/** A file's download: ?tagged=1 gives the 整理版 (tags and cover from the catalog), else the original. */
export const GET: APIRoute = async ({ params, url, request, locals }) => {
  const file = await db().prepare('SELECT * FROM files WHERE id = ?').bind(params.id).first<FileRow>();
  if (!file?.blob_key) return new Response(locals.t('找不到文件'), { status: 404 });
  if (url.searchParams.get('tagged') === '1') {
    const src = await taggedSource(file);
    if (src) return taggedResponse(env.MEDIA, src);
  }
  return serveObject(env.MEDIA, file.blob_key, request, file.download_name ?? file.name);
};
