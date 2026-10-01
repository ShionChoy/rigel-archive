import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json } from '../../../../lib/api';
import { TASK_VERSIONS, clipItems, taskItems } from '../../../../lib/processing';

/**
 * Contents waiting to be derived, fingerprinted or cut into preview clips, with the version of the rules the
 * site expects; kind=video or kind=other lists only videos or only the rest.
 */
export const GET: APIRoute = async ({ url }) => {
  const task = url.searchParams.get('task');
  if (task === 'clip') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    return json({ version: TASK_VERSIONS.clip, items: await clipItems(env.DB, limit) });
  }
  if (task !== 'derive' && task !== 'fingerprint') return fail('task 只能是 derive、fingerprint 或 clip');
  const kind = url.searchParams.get('kind');
  if (kind !== null && kind !== 'video' && kind !== 'other') return fail('kind 只能是 video 或 other');
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  return json({ version: TASK_VERSIONS[task], items: await taskItems(env.DB, task, limit, kind) });
};
