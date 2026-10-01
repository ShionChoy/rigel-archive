// 版本页「公开站」's file settings (scripts/edition-access.ts): POST {"op": "files", ids, patch} sets the access
// (and rights) of these files of the edition, {"op": "reset", ids} makes them follow the edition again. One
// undoable change each; the reply carries its batch for 「撤销」.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fromAdminPage, json, readJson } from '../../../../lib/api';
import { batchSince } from '../../../../lib/changes';
import { db, type EditionRow, type ReleaseRow } from '../../../../lib/db';
import { cleanPatch, setFileAccess } from '../../../../lib/edition-access';
import { errorText, UserError } from '../../../../lib/i18n';
import { wakeAfter } from '../../../../lib/schedule';

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  const started = new Date().toISOString();
  try {
    const database = db();
    const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(params.id).first<EditionRow>();
    if (!edition) throw new UserError('找不到版本');
    const release = (await database.prepare('SELECT catalog_no, title FROM releases WHERE id = ?').bind(edition.release_id).first<Pick<ReleaseRow, 'catalog_no' | 'title'>>())!;
    const body = await readJson(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 5000) : [];
    let patch;
    if (body.op === 'files') patch = cleanPatch((body.patch ?? {}) as Record<string, unknown>);
    else if (body.op === 'reset') patch = { pub_visible: null, pub_play: null, pub_clip: null, pub_quality: null, pub_download: null };
    else throw new UserError('未知的操作');
    const n = await setFileAccess(locals.admin!.email, release, edition, ids, patch, t);
    // A preview clip may be wanted now: the processing program cuts it.
    if (n && ('pub_play' in patch || 'pub_clip' in patch || body.op === 'reset')) wakeAfter(locals, env);
    const batch = n ? await batchSince(database, locals.admin!.email, started) : null;
    return json({ ok: true, msg: n ? t('已修改 {n} 个文件的公开设置', { n }) : t('没有改动'), batch });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
