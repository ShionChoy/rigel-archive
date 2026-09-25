import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json, readJson } from '../../../../lib/api';

/** The backup run's start and end, shown on the storage page (table backup_runs). */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    if (body.action === 'start') {
      const row = await env.DB.prepare('INSERT INTO backup_runs DEFAULT VALUES RETURNING id').first<{ id: number }>();
      return json({ id: row!.id });
    }
    if (body.action === 'finish') {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return fail('id 无效');
      await env.DB.prepare(
        "UPDATE backup_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), ok = ?, report = ? WHERE id = ?",
      )
        .bind(body.ok ? 1 : 0, JSON.stringify(body.report ?? {}).slice(0, 100_000), id)
        .run();
      return json({ ok: true });
    }
    return fail('未知的操作');
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
