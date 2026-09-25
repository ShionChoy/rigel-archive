import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, fail, json, readJson } from '../../../../lib/api';
import { TASKS, claim, touch, type Task } from '../../../../lib/processing';

/**
 * Take a content for a task before working on it (see media_tasks in migrations/0005); with
 * `touch: true`, renew a claim the caller is still working on.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    const task = String(body.task ?? '') as Task;
    const sha256 = String(body.sha256 ?? '');
    const version = Number(body.version);
    if (!TASKS.includes(task) || !SHA256_HEX.test(sha256) || !Number.isInteger(version)) return fail('参数无效');
    if (body.touch === true) return json({ claimed: await touch(env.DB, task, sha256) });
    return json({ claimed: await claim(env.DB, task, sha256, version) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
