import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, fromAdminPage, json, readJson } from '../../../../lib/api';
import { errorText } from '../../../../lib/i18n';
import { wakeAfter } from '../../../../lib/schedule';
import { replaceFile } from '../../../../lib/upload';

/** After the new version's bytes are stored: add it as the replacement of an existing file. */
export const POST: APIRoute = async ({ request, url, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  try {
    const body = await readJson(request);
    const mtime = body.mtime ? String(body.mtime) : null;
    const id = await replaceFile(env.DB, env.MEDIA, locals.admin!.email, {
      old: String(body.old ?? ''),
      sha256: String(body.sha256 ?? ''),
      size: Number(body.size),
      name: String(body.name ?? ''),
      mtime: mtime && !Number.isNaN(Date.parse(mtime)) ? new Date(mtime).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    });
    wakeAfter(locals, env); // verify and process it right away
    return json({ id });
  } catch (e) {
    return fail(errorText(e, locals.t));
  }
};
