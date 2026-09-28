// The 整理台's 「标签与封面」, as JSON: GET ?file=<id> gives what the dialog shows; POST {"op": "save", file,
// title, credits, album_title, entry, cover?} saves a file's 整理版 tags, {"op": "cover", image} makes a
// picture the cover of its edition (or release). Answers {ok, msg, batch} or {ok: false, err}.
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../../lib/api';
import { CREDIT_FIELDS, type Credits } from '../../../lib/editions';
import { errorText, summaryText, UserError } from '../../../lib/i18n';
import { saveFileTags, setCover, tagEditView } from '../../../lib/tagedit';

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    return json({ ok: true, view: await tagEditView(url.searchParams.get('file') ?? '') });
  } catch (e) {
    return json({ ok: false, err: errorText(e, locals.t) }, 400);
  }
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  const actor = locals.admin!.email;
  try {
    const body = await readJson(request);
    let r: { changed: number; batchId: string; summary: string };
    if (body.op === 'save') {
      const raw = (body.credits ?? {}) as Record<string, unknown>;
      const credits = Object.fromEntries(CREDIT_FIELDS.map((f) => [f, str(raw[f])])) as Credits;
      r = await saveFileTags(actor, str(body.file), {
        title: str(body.title), credits, album_title: str(body.album_title), entry: str(body.entry),
        cover: body.cover === undefined ? undefined : str(body.cover),
      });
    } else if (body.op === 'cover') {
      r = await setCover(actor, str(body.image));
    } else throw new UserError('未知的操作');
    return json({ ok: true, msg: r.changed ? summaryText(r.summary, t) : t('没有改动'), batch: r.changed ? r.batchId : null });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
