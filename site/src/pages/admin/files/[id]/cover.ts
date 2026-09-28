import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { db, type FileRow } from '../../../../lib/db';
import { pictureUrl, readNow } from '../../../../lib/embedded';

/** The cover a stored audio file carries (read once, then kept by content): a redirect to the picture. */
export const GET: APIRoute = async ({ params, locals, redirect }) => {
  const database = db();
  const file = await database.prepare('SELECT sha256 FROM files WHERE id = ?').bind(params.id).first<Pick<FileRow, 'sha256'>>();
  if (!file?.sha256) return new Response(locals.t('找不到文件'), { status: 404 });
  await readNow(database, env.MEDIA, [file.sha256], 8000);
  const row = await database.prepare('SELECT cover FROM embedded WHERE sha256 = ?').bind(file.sha256).first<{ cover: string | null }>();
  if (!row?.cover) return new Response(locals.t('这个文件没有内嵌封面'), { status: 404 });
  return redirect(pictureUrl(row.cover), 302);
};
