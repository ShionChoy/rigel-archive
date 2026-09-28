// 智能文件夹 (JSON): {"op": "save", "id"?, "name", "rules"} | {"op": "delete", "id"}.
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../../lib/api';
import { Places } from '../../../lib/locations';
import { deleteSmartFolder, parseRuleSet, saveSmartFolder } from '../../../lib/smart';
import { errorText, UserError } from '../../../lib/i18n';

export const POST: APIRoute = async ({ request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const body = await readJson(request);
    if (body.op === 'save') {
      const id = await saveSmartFolder(locals.admin!.email, body.id ? String(body.id) : null, String(body.name ?? ''), parseRuleSet(body.rules), await Places.load());
      return json({ ok: true, id, msg: t('已保存智能文件夹') });
    }
    if (body.op === 'delete') {
      await deleteSmartFolder(String(body.id ?? ''));
      return json({ ok: true, msg: t('已删除智能文件夹') });
    }
    throw new UserError('未知的操作');
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
