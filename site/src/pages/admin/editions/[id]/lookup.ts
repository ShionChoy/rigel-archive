// The edition page's 「查找元数据」 panel, as JSON:
//   GET ?op=candidates[&q=<words>]   candidates, best first
//   GET ?op=release&ref=<id or link>  one candidate in full (tags in Picard's names, per track)
//   POST {"op": "cover", "url": …}    store an online cover in the edition's 附件 → {id}
import type { APIRoute } from 'astro';
import { fromAdminPage, json, readJson } from '../../../../lib/api';
import { db, type EditionRow, type ReleaseRow } from '../../../../lib/db';
import { errorText, UserError } from '../../../../lib/i18n';
import { candidates, fetchOnline, storeOnlineCover } from '../../../../lib/lookup';

async function load(id: string | undefined) {
  const database = db();
  const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(id ?? '').first<EditionRow>();
  if (!edition) throw new UserError('找不到版本');
  const release = (await database.prepare('SELECT * FROM releases WHERE id = ?').bind(edition.release_id).first<ReleaseRow>())!;
  return { edition, release };
}

export const GET: APIRoute = async ({ params, url, locals }) => {
  try {
    const { edition, release } = await load(params.id);
    const op = url.searchParams.get('op');
    if (op === 'candidates') return json({ ok: true, candidates: await candidates(edition, release, url.searchParams.get('q')) });
    if (op === 'release') return json({ ok: true, release: await fetchOnline(url.searchParams.get('ref') ?? '') });
    throw new UserError('未知的操作');
  } catch (e) {
    return json({ ok: false, err: errorText(e, locals.t) }, 400);
  }
};

export const POST: APIRoute = async ({ params, request, url, locals }) => {
  const { t } = locals;
  if (!fromAdminPage(request, url)) return json({ ok: false, err: t('请从后台页面操作') }, 403);
  try {
    const { edition, release } = await load(params.id);
    const body = await readJson(request);
    if (body.op !== 'cover') throw new UserError('未知的操作');
    return json({ ok: true, id: await storeOnlineCover(locals.admin!.email, edition, release, String(body.url ?? '')) });
  } catch (e) {
    return json({ ok: false, err: errorText(e, t) }, 400);
  }
};
