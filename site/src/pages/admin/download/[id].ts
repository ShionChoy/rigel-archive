import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { serveObject } from '../../../lib/api';
import { mimeFor } from '../../../lib/constants';
import { db, type FileRow } from '../../../lib/db';
import { taggedResponse, taggedSource } from '../../../lib/tags';

/**
 * A file's download: ?tagged=1 gives it with its tags (&as=flac: a WAV as its stream FLAC), else the original,
 * byte for byte as collected, under its name (the renamed one when it was renamed).
 */
export const GET: APIRoute = async ({ params, url, request, locals }) => {
  const file = await db().prepare('SELECT * FROM files WHERE id = ?').bind(params.id).first<FileRow>();
  if (!file?.blob_key) return new Response(locals.t('找不到文件'), { status: 404 });
  if (url.searchParams.get('tagged') === '1') {
    const src = await taggedSource(file, undefined, url.searchParams.get('as') === 'flac' ? 'flac' : undefined);
    if (src) return taggedResponse(env.MEDIA, src);
  }
  return serveObject(env.MEDIA, file.blob_key, request, file.download_name ?? file.name, mimeFor(file.ext));
};
