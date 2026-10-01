declare namespace App {
  interface Locals {
    /** Set by src/middleware.ts on every /admin request. */
    admin?: {
      email: string;
      name: string | null;
      role: 'owner' | 'admin' | 'editor' | 'worker'; // worker = `ra worker`, only on /admin/api/worker/*
      lang: import('./lib/i18n').Lang | null; // the admin's own setting (admins.lang)
    };
    /** Interface language of this request and its translator (see lib/i18n.ts): the admin's (zh, ja), or on
     * the public site the one in the address (zh, ja, en). */
    lang: import('./lib/i18n').SiteLang;
    t: import('./lib/i18n').T;
  }
}

/**
 * Secrets (see wrangler.jsonc). `npm run types` only knows the ones in .dev.vars, so they are declared
 * here too: a fresh checkout without .dev.vars still type-checks. Both Env types get them: the global
 * one and Cloudflare.Env, the type of `env` from cloudflare:workers.
 */
interface Secrets {
  WORKER_TOKEN: string;
  // Signs the public site's media addresses (lib/public/media.ts); a fixed key stands in for it in `astro dev`.
  MEDIA_KEY?: string;
  // The encrypted backup's, set once B2 is configured.
  B2_KEY_ID?: string;
  B2_APP_KEY?: string;
  B2_BUCKET?: string;
  BACKUP_CRYPT_PASSWORD?: string;
  BACKUP_CRYPT_SALT?: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}

/**
 * The one Node API the site uses (with the nodejs_compat flag): a synchronous HMAC for signing media
 * addresses (lib/public/media.ts). Declared here rather than pulling in all of @types/node.
 */
declare module 'node:crypto' {
  export function createHmac(algorithm: 'sha256', key: string): { update(data: string): { digest(encoding: 'base64url' | 'hex'): string } };
}

/** This build's id (astro.config.mjs): part of the public pages' edge-cache key (lib/public/cache.ts). */
declare const __BUILD_ID__: string;
