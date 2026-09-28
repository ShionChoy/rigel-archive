// The edition page's tag editor data as JSON (the 整理台's 「编辑标签与封面」 dialog uses it).
import type { APIRoute } from 'astro';
import { json } from '../../../../lib/api';
import { db, type EditionRow, type ReleaseRow } from '../../../../lib/db';
import { editorData } from '../../../../lib/edition-editor';
import { Places } from '../../../../lib/locations';

export const GET: APIRoute = async ({ params, locals }) => {
  const database = db();
  const edition = await database.prepare('SELECT * FROM editions WHERE id = ?').bind(params.id).first<EditionRow>();
  if (!edition) return json({ ok: false, err: locals.t('找不到版本') }, 404);
  const release = (await database.prepare('SELECT * FROM releases WHERE id = ?').bind(edition.release_id).first<ReleaseRow>())!;
  return json({ ok: true, data: await editorData(edition, release, await Places.load(), locals.t) });
};
