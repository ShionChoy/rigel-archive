// The public site's addresses for stored objects (pages/media/[...path].ts serves them). Pages only ever
// hand out addresses for what the public rules allow (lib/public/rules.ts); the signature is what lets the
// media route serve them without asking the database again, and what keeps anyone from guessing the
// address of anything else.
//
//   /media/i/<sig>/<key>          pictures (previews, covers): lasting, cached by browsers and the edge
//   /media/s/<exp>/<sig>/<key>    sound, video, text: valid until <exp> (unix seconds)
//
// Expiring addresses end on a 10-minute mark at least LIFETIME away, so a page renders the same address
// for 10 minutes (browser and edge caches keep working) and it is good for two hours after that.
// The player asks /api/play for a new one when an address has run out.

import { createHmac } from 'node:crypto';
import { env } from 'cloudflare:workers';
import type { MediaUrls, MediaFile } from '../media';

const LIFETIME = 2 * 3600;
const STEP = 600;
/** Stands in for the MEDIA_KEY secret in `astro dev`; deployed sites without the secret serve no media. */
const DEV_KEY = 'rigel-dev-media-key';

export const OBJECT_KEY = /^(blobs|derived|pictures)\/[\w./-]+$/;

function secret(): string | null {
  return env.MEDIA_KEY || (import.meta.env.DEV ? DEV_KEY : null);
}

const sign = (text: string, key: string) => createHmac('sha256', key).update(text).digest('base64url').slice(0, 22);

/** When addresses made now stop working (unix seconds). */
export function expiryFrom(now = Date.now()): number {
  return Math.ceil((now / 1000 + LIFETIME) / STEP) * STEP;
}

/** The addresses of the public site for this request; null when the site has no MEDIA_KEY. */
export function publicUrls(now = Date.now()): (MediaUrls & { expires: number }) | null {
  const key = secret();
  if (!key) return null;
  const exp = expiryFrom(now);
  const object = (objectKey: string, lasting: boolean): string | null => {
    if (!OBJECT_KEY.test(objectKey) || objectKey.includes('..')) return null;
    return lasting ? `/media/i/${sign(`i:${objectKey}`, key)}/${objectKey}` : `/media/s/${exp}/${sign(`s:${exp}:${objectKey}`, key)}/${objectKey}`;
  };
  return {
    object,
    original: (file: MediaFile, lasting: boolean) => (file.blob_key ? object(file.blob_key, lasting) : null),
    expires: exp,
  };
}

/** The addresses of a site without MEDIA_KEY: pages still show, with nothing to play or look at. */
export const NO_MEDIA: MediaUrls & { expires: number } = { object: () => null, original: () => null, expires: 0 };

export type Checked = { key: string; lasting: boolean; expires: number | null } | { error: 'expired' | 'invalid' };

/** The object a /media address names, when its signature holds and it has not run out. */
export function checkAddress(path: string, now = Date.now()): Checked {
  const key = secret();
  if (!key) return { error: 'invalid' };
  const lasting = /^i\/([\w-]{22})\/(.+)$/.exec(path);
  if (lasting) {
    const [, sig, objectKey] = lasting;
    if (!OBJECT_KEY.test(objectKey) || objectKey.includes('..') || !same(sig, sign(`i:${objectKey}`, key))) return { error: 'invalid' };
    return { key: objectKey, lasting: true, expires: null };
  }
  const timed = /^s\/(\d{9,11})\/([\w-]{22})\/(.+)$/.exec(path);
  if (timed) {
    const [, expText, sig, objectKey] = timed;
    const exp = Number(expText);
    if (!OBJECT_KEY.test(objectKey) || objectKey.includes('..') || !same(sig, sign(`s:${exp}:${objectKey}`, key))) return { error: 'invalid' };
    if (exp * 1000 < now) return { error: 'expired' };
    return { key: objectKey, lasting: false, expires: exp };
  }
  return { error: 'invalid' };
}

/** Compare two signatures in constant time. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
