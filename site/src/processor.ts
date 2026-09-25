// The processing program in the cloud: a Cloudflare container running `ra container` (tools/ra), driven
// by this Durable Object. There is one instance ("main"). It is started when there is work (after an
// upload, and by the cron in worker.ts), stops by itself once idle, and runs the nightly backup.
//
// The container reaches the site as http://site.internal: those requests never leave Cloudflare. They
// are handed straight to the site's own /admin/api/worker/* routes with WORKER_TOKEN added here, so the
// container holds no site secrets and does not pass Cloudflare Access.

import { handle } from '@astrojs/cloudflare/handler';
import { Container, getContainer } from '@cloudflare/containers';

export const PROCESSOR_NAME = 'main';
const BUSY_LIMIT_MS = 6 * 3600_000; // a job that has shown no progress for this long is taken as stuck

/** Outbound handler: the container's calls to http://site.internal/admin/api/worker/*. */
async function siteCall(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/admin/api/worker/')) return new Response('not found', { status: 404 });
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${env.WORKER_TOKEN}`);
  const forwarded = new Request(url, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    // @ts-expect-error -- streaming request bodies need duplex in the Fetch API
    duplex: 'half',
  });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const response = await handle(forwarded, env, ctx);
  await Promise.all(pending);
  return response;
}

export interface ProcessorStatus {
  state: string; // running | healthy | stopping | stopped | stopped_with_code | unavailable
  busy?: boolean;
  task?: string;
  video?: { name: string; since: number } | null; // the video being transcoded in its own lane
  up_since?: number;
  progress_at?: number;
  done?: number;
  failed?: number;
  errors?: string[];
  backup_requested?: boolean;
  last_backup?: Record<string, string | number | boolean | null> | null;
  error?: string;
}

/** Backup settings for the container, when all of them are set (Worker secrets). */
export function backupSettings(env: Env): Record<string, string> | null {
  const values = {
    B2_KEY_ID: env.B2_KEY_ID,
    B2_APP_KEY: env.B2_APP_KEY,
    B2_BUCKET: env.B2_BUCKET,
    BACKUP_CRYPT_PASSWORD: env.BACKUP_CRYPT_PASSWORD,
    BACKUP_CRYPT_SALT: env.BACKUP_CRYPT_SALT,
  };
  return Object.values(values).every((v) => typeof v === 'string' && v !== '') ? (values as Record<string, string>) : null;
}

export class Processor extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true; // the backup talks to Backblaze B2

  static {
    // Assigned (not declared as a static field, which would bypass the base class's setter that
    // registers the handler): the container's requests to http://site.internal come here.
    this.outboundByHost = { 'site.internal': (request: Request, env: unknown) => siteCall(request, env as Env) };
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { RA_SITE: 'http://site.internal', ...(backupSettings(env) ?? {}) };
  }

  private running(status: string): boolean {
    return status === 'running' || status === 'healthy';
  }

  /**
   * The container's own account of what it is doing. Asked on its port directly: a request through
   * containerFetch counts as activity and would keep an idle container (and its bill) running for another
   * sleepAfter each time someone looks at /admin/storage.
   */
  private async peek(): Promise<ProcessorStatus> {
    const port = this.ctx.container!.getTcpPort(this.defaultPort);
    return (await (await port.fetch('http://container/status')).json()) as ProcessorStatus;
  }

  /** Start the container if needed and have it look at the queue now (and run the backup). */
  async wake(backup = false): Promise<ProcessorStatus> {
    await this.startAndWaitForPorts();
    const response = await this.containerFetch(`http://container/wake${backup ? '?backup=1' : ''}`, { method: 'POST' });
    return { state: 'healthy', ...((await response.json()) as object) };
  }

  /**
   * Stop the container (the work in hand is picked up again: claims not renewed for 20 minutes lapse)
   * and start it again, e.g. to run a newly deployed image right away.
   */
  async restart(): Promise<ProcessorStatus> {
    const stopped = async () => ['stopped', 'stopped_with_code'].includes((await this.getState()).status);
    if (!(await stopped())) {
      await this.stop();
      for (let i = 0; i < 30 && !(await stopped()); i += 1) await new Promise((r) => setTimeout(r, 1000));
      if (!(await stopped())) await this.destroy(); // did not stop within 30 s: kill it
    }
    return this.wake();
  }

  /** What the container is doing, without starting it. */
  async status(): Promise<ProcessorStatus> {
    const state = await this.getState();
    // Exit code 0 is how an idle container stops (SIGTERM, then a clean exit); only another code is a failure.
    if (state.status === 'stopped_with_code' && !state.exitCode) return { state: 'stopped' };
    if (!this.running(state.status)) return { state: state.status };
    try {
      return { ...(await this.peek()), state: state.status };
    } catch (e) {
      return { state: state.status, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Idle for sleepAfter: stop, unless a long job (a video, the first backup) is still going. */
  override async onActivityExpired(): Promise<void> {
    const state = await this.getState();
    if (!this.running(state.status)) return;
    try {
      const s = await this.peek();
      if (s.busy && Date.now() - (s.progress_at ?? 0) * 1000 < BUSY_LIMIT_MS) return; // the timer is renewed after this
    } catch {
      // not answering: stop it
    }
    await this.stop();
    // A program that ignores the stop signal would keep the container (and its bill) running.
    await new Promise((r) => setTimeout(r, 30_000));
    if (this.running((await this.getState()).status)) await this.destroy();
  }
}

export function processor(env: Env) {
  return getContainer(env.PROCESSOR, PROCESSOR_NAME);
}
