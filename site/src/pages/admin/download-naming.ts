// 「带标签下载的文件名」: the team's naming template ({template: "…"}, lib/naming.ts).
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../lib/api';
import { errorText } from '../../lib/i18n';
import { saveNaming } from '../../lib/tags';

export const POST: APIRoute = async ({ request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const body = await readJson(request);
    await saveNaming(typeof body.template === 'string' ? body.template : '');
    return json({ ok: true, msg: t('已保存下载文件名的格式') });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
