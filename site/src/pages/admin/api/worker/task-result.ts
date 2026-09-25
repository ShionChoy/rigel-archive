import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, fail, json, readJson } from '../../../../lib/api';
import { TASKS, checkOutputs, finishStatement, saveDerived, type Task } from '../../../../lib/processing';

const FINGERPRINT = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The processing program reports one content: the derived files it stored, the fingerprint, or why
 * the task failed. Machine-made data only, so no revision is written.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    const task = String(body.task ?? '') as Task;
    const sha256 = String(body.sha256 ?? '');
    const version = Number(body.version);
    if (!TASKS.includes(task) || !SHA256_HEX.test(sha256) || !Number.isInteger(version)) return fail('参数无效');
    if (body.error) {
      await finishStatement(env.DB, task, sha256, version, String(body.error)).run();
      return json({ ok: true });
    }
    if (task === 'derive') {
      const outputs = await checkOutputs(env.MEDIA, body.outputs);
      await saveDerived(env.DB, env.MEDIA, sha256, version, outputs);
      return json({ ok: true, outputs: outputs.length });
    }
    if (task === 'fingerprint') {
      const fp = String(body.fp ?? '');
      const duration = Number(body.duration);
      if (!FINGERPRINT.test(fp) || fp.length > 1_500_000 || !(duration > 0)) return fail('指纹数据无效');
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO fingerprints (sha256, duration, fp) VALUES (?, ?, ?)
           ON CONFLICT (sha256) DO UPDATE SET duration = excluded.duration, fp = excluded.fp,
             created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
        ).bind(sha256, duration, fp),
        finishStatement(env.DB, task, sha256, version, null),
      ]);
      return json({ ok: true });
    }
    return fail('上传的核对结果请用 /admin/api/worker/result');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
