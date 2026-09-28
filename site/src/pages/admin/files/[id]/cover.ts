import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { db, type FileRow } from '../../../../lib/db';
import { embeddedCover } from '../../../../lib/tags';

/** The cover embedded in a FLAC or MP3, read from the start of the stored original. */
export const GET: APIRoute = async ({ params, locals }) => {
  const file = await db().prepare('SELECT blob_key, ext, size FROM files WHERE id = ?').bind(params.id).first<Pick<FileRow, 'blob_key' | 'ext' | 'size'>>();
  if (!file?.blob_key) return new Response(locals.t('找不到文件'), { status: 404 });
  const cover = await embeddedCover(env.MEDIA, file.blob_key, file.ext, file.size).catch(() => null);
  if (!cover || !/^image\/(jpeg|png|gif|webp)$/.test(cover.mime)) return new Response(locals.t('这个文件没有内嵌封面'), { status: 404 });
  return new Response(cover.image.slice(), {
    headers: {
      'content-type': cover.mime,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
};
