declare namespace App {
  interface Locals {
    /** Set by src/middleware.ts on every /admin request. */
    admin?: {
      email: string;
      name: string | null;
      role: 'owner' | 'admin' | 'editor' | 'worker'; // worker = `ra worker`, only on /admin/api/worker/*
      lang: import('./lib/i18n').Lang | null; // the admin's own setting (admins.lang)
    };
    /** Interface language of this request and its translator (see lib/i18n.ts). */
    lang: import('./lib/i18n').Lang;
    t: import('./lib/i18n').T;
  }
}

/** Secrets of the encrypted backup, set once B2 is configured (see wrangler.jsonc). */
interface Env {
  B2_KEY_ID?: string;
  B2_APP_KEY?: string;
  B2_BUCKET?: string;
  BACKUP_CRYPT_PASSWORD?: string;
  BACKUP_CRYPT_SALT?: string;
}
