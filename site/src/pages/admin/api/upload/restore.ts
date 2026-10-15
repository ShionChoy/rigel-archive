import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, fromAdminPage, json, readJson } from '../../../../lib/api';
import { errorText } from '../../../../lib/i18n';
import { wakeAfter } from '../../../../lib/schedule';
import { restoreContent } from '../../../../lib/upload';

/** 「补传内容」: after the original's bytes are stored, the record that lacked them (and its copies) point at them. */
export const POST: APIRoute = async ({ request, url, locals }) => {
  if (!fromAdminPage(request, url)) return fail(locals.t('请求来源不对'), 403);
  try {
    const body = await readJson(request);
    const updated = await restoreContent(env.DB, env.MEDIA, locals.admin!.email, { file: String(body.file ?? ''), sha256: String(body.sha256 ?? ''), size: Number(body.size) });
    wakeAfter(locals, env); // previews and streams of the restored content
    return json({ updated });
  } catch (e) {
    return fail(errorText(e, locals.t));
  }
};
