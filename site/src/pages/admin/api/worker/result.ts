import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, fail, json, readJson } from '../../../../lib/api';
import { TASK_VERSIONS, finishStatement } from '../../../../lib/processing';

/**
 * `ra worker` reports on one uploaded content: its specs, or why it failed (e.g. the stored bytes do
 * not match the SHA-256). Machine-read columns only; no revision, like the import's refresh.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    const sha256 = String(body.sha256 ?? '');
    if (!SHA256_HEX.test(sha256)) return fail('SHA-256 无效');
    const format = body.error
      ? { upload_error: String(body.error).slice(0, 500) }
      : body.format && typeof body.format === 'object' ? body.format : null;
    const pcm = typeof body.pcm_md5 === 'string' && /^[0-9a-f]{32}$/.test(body.pcm_md5) ? body.pcm_md5 : null;
    const [result] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE files SET format = ?, pcm_md5 = ?, checked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE sha256 = ? AND origin = 'upload' AND checked_at IS NULL`,
      ).bind(format ? JSON.stringify(format) : null, pcm, sha256),
      finishStatement(env.DB, 'check', sha256, TASK_VERSIONS.check, null),
    ]);
    return json({ updated: result.meta.changes });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
