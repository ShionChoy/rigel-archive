import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, fromAdminPage, json, readJson } from '../../../../lib/api';
import { errorText } from '../../../../lib/i18n';
import { wakeAfter } from '../../../../lib/schedule';
import { parseUpload, registerUpload } from '../../../../lib/upload';

/** After the bytes are stored: add the file to the 整理台. */
export const POST: APIRoute = async ({ request, url, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  try {
    const input = parseUpload(await readJson(request));
    const id = await registerUpload(env.DB, env.MEDIA, locals.admin!.email, input);
    wakeAfter(locals, env); // verify and process it right away
    return json({ id });
  } catch (e) {
    return fail(errorText(e, locals.t));
  }
};
