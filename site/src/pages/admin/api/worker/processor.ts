import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json, readJson } from '../../../../lib/api';
import { pendingCounts } from '../../../../lib/processing';
import { backupSettings, processor } from '../../../../processor';

// The processing container, for operators (`uv run ra processor …`): its status and the queue; start it,
// restart it on a newly deployed image, or run the backup now.

export const GET: APIRoute = async () => {
  const [status, pending] = await Promise.all([
    processor(env).status().catch((e) => ({ state: 'unavailable', error: e instanceof Error ? e.message : String(e) })),
    pendingCounts(env.DB),
  ]);
  return json({ status, pending, backup_configured: backupSettings(env) !== null });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    const stub = processor(env);
    switch (body.action) {
      case 'wake':
        return json({ status: await stub.wake() });
      case 'restart':
        return json({ status: await stub.restart() });
      case 'backup':
        if (!backupSettings(env)) return fail('备份还没有设置');
        return json({ status: await stub.wake(true) });
      default:
        return fail('未知的操作');
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
