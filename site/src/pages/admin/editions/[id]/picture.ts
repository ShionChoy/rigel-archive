// The cover dialog's upload: a JPEG / PNG goes into the edition's 附件 and comes back as a choice.
import type { APIRoute } from 'astro';
import { fromAdminPage, json } from '../../../../lib/api';
import { db, type EditionRow } from '../../../../lib/db';
import { uploadPicture } from '../../../../lib/edition-editor';
import { errorText, UserError } from '../../../../lib/i18n';

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const edition = await db().prepare('SELECT * FROM editions WHERE id = ?').bind(params.id).first<EditionRow>();
    if (!edition) throw new UserError('找不到版本');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new UserError('没有选择图片');
    const id = await uploadPicture(locals.admin!.email, edition, file, t);
    return json({ ok: true, id });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
