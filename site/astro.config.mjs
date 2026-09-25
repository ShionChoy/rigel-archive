// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  // Admin auth comes from Cloudflare Access, not Astro sessions, so no KV binding is needed.
  session: false,
  security: { checkOrigin: true },
});
