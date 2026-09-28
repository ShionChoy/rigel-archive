// The 整理台's tags and covers, as JSON: GET ?file=<id> gives what the file downloads with and where it
// is in its edition's track list (the dialog then edits the list through /admin/editions/<id>/tags);
// POST {"op": "cover", file} makes a picture, or the cover an audio file carries, its edition's cover.
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../../lib/api';
import { errorText, summaryText, UserError } from '../../../lib/i18n';
import { fileTagView, setCover } from '../../../lib/tagedit';

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    return json({ ok: true, view: await fileTagView(url.searchParams.get('file') ?? '') });
  } catch (e) {
    return json({ ok: false, err: errorText(e, locals.t) }, 400);
  }
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const body = await readJson(request);
    if (body.op !== 'cover') throw new UserError('未知的操作');
    const r = await setCover(locals.admin!.email, String(body.file ?? body.image ?? ''));
    return json({ ok: true, msg: r.changed ? summaryText(r.summary, t) : t('没有改动'), batch: r.changed ? r.batchId : null });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
