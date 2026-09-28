// 「显示哪些标签」: the tags the team shows even when empty ({names: [...]}).
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../lib/api';
import { saveDisplayTags } from '../../lib/edition-editor';
import { errorText } from '../../lib/i18n';

export const POST: APIRoute = async ({ request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const body = await readJson(request);
    await saveDisplayTags(Array.isArray(body.names) ? body.names.map(String) : []);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
