import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json, readJson } from '../../../../lib/api';
import { shaList, storedSizes } from '../../../../lib/blobs';

/**
 * `ra push` reports contents it has stored: every file with that content gets its blob_key, which
 * makes previews and downloads read from storage. Checked against storage first (content and size).
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const shas = shaList(await readJson(request));
    const sizes = await storedSizes(env.MEDIA, shas);
    const ok = shas.filter((s) => sizes.has(s));
    if (ok.length === 0) return json({ updated: 0, missing: shas });
    const result = await env.DB.prepare(
      `UPDATE files SET blob_key = 'blobs/' || sha256
       WHERE blob_key IS NULL AND sha256 IN (SELECT value FROM json_each(?1))
         AND size = (SELECT s.value FROM json_each(?2) s WHERE s.key = files.sha256)`,
    )
      .bind(JSON.stringify(ok), JSON.stringify(Object.fromEntries(ok.map((s) => [s, sizes.get(s)]))))
      .run();
    return json({ updated: result.meta.changes, missing: shas.filter((s) => !sizes.has(s)) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
