// Scheduled work (crons in wrangler.jsonc) and waking the processing container.

import { backupSettings, processor } from '../processor';
import { failAbandoned, pendingCounts } from './processing';

/** Every 10 minutes: start the processing container when anything is waiting (it stops by itself). */
export const QUEUE_CRON = '*/10 * * * *';
/** Every night at 04:17 in Japan: the encrypted backup. */
export const BACKUP_CRON = '17 19 * * *';

export async function wakeProcessor(env: Env, backup = false): Promise<void> {
  try {
    await processor(env).wake(backup);
  } catch (e) {
    // Local development runs without the container (`uv run ra worker` does the work there).
    console.error('processing container not started:', e instanceof Error ? e.message : e);
  }
}

/** After a request queued work (an upload): wake the container once the response has gone out. */
export function wakeAfter(locals: App.Locals, env: Env): void {
  locals.cfContext?.waitUntil(wakeProcessor(env));
}

/** Wake the container when there is work. */
export async function wakeIfPending(env: Env): Promise<void> {
  await failAbandoned(env.DB);
  const pending = await pendingCounts(env.DB);
  if (Object.values(pending).some((n) => n > 0)) await wakeProcessor(env);
}

export async function onSchedule(cron: string, env: Env): Promise<void> {
  if (cron === BACKUP_CRON && backupSettings(env)) return wakeProcessor(env, true);
  return wakeIfPending(env);
}
