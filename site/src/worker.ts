// The Worker's entry point: the Astro site, plus the scheduled jobs and the processing container.
import { handle } from '@astrojs/cloudflare/handler';
import { onSchedule } from './lib/schedule';

export { ContainerProxy } from '@cloudflare/containers'; // carries the container's calls to site.internal
export { Processor } from './processor';

export default {
  fetch: handle,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(onSchedule(controller.cron, env));
  },
} satisfies ExportedHandler<Env>;
