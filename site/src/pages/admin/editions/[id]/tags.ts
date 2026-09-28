// Saving the edition page's tag editor: {version, rows: [{id, disc, tags, cover, title?}], links?}.
// Answers {ok, msg, batch} or {ok: false, err}.
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../../../lib/api';
import { db, type EditionRow, type ReleaseRow } from '../../../../lib/db';
import { saveEditionTags, type SaveBody } from '../../../../lib/edition-editor';
import { errorText } from '../../../../lib/i18n';

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const database = db();
    const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(params.id).first<EditionRow>();
    if (!edition) return json({ ok: false, err: t('找不到版本') }, 404);
    const release = (await database
      .prepare('SELECT r.*, e.name AS era_name FROM releases r JOIN eras e ON e.id = r.era_id WHERE r.id = ?')
      .bind(edition.release_id)
      .first<ReleaseRow & { era_name: string }>())!;
    const body = (await readJson(request)) as unknown as SaveBody;
    const r = await saveEditionTags(locals.admin!.email, edition, release, body);
    return json({ ok: true, msg: r.changed ? t('已保存（{n} 处改动）', { n: r.changed }) : t('没有改动'), batch: r.changed ? r.batchId : null });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
