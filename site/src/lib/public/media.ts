// The public site's addresses for stored objects (pages/media/[...path].ts serves them). Pages only ever
// hand out addresses for what the public rules allow (lib/public/rules.ts); the signature is what lets the
// media route serve them without asking the database again, and what keeps anyone from guessing the
// address of anything else.
//
//   /media/i/<epoch>/<sig>/<key>          pictures (previews, covers): lasting, cached by browsers and the edge
//   /media/s/<epoch>/<exp>/<sig>/<key>    sound, video, text: valid until <exp> (unix seconds)
//
// Expiring addresses end on a 10-minute mark at least LIFETIME away, so a page renders the same address
// for 10 minutes (browser and edge caches keep working) and it is good for two hours after that.
// The player asks /api/play for a new one when an address has run out.
//
// <epoch> is meta.media_epoch, counted up whenever a change may close something the public site was showing
// (lib/changes.ts): addresses of an older epoch stop working at once (sound and text answer 410, so the
// player asks for new ones and goes on with what is still open; pictures 404).

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

/** meta.media_epoch, read at most every few seconds per Worker instance. */
let known: { value: number; at: number } | null = null;

export async function mediaEpoch(now = Date.now(), fresh = false): Promise<number> {
  if (!fresh && known && now - known.at < 5000) return known.value;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'media_epoch'").first<{ value: string }>();
  known = { value: Number(row?.value) || 1, at: now };
  return known.value;
}

/** When addresses made now stop working (unix seconds). */
export function expiryFrom(now = Date.now()): number {
  return Math.ceil((now / 1000 + LIFETIME) / STEP) * STEP;
}

/** The addresses of the public site for this request; null when the site has no MEDIA_KEY. */
export async function publicUrls(now = Date.now()): Promise<(MediaUrls & { expires: number }) | null> {
  const key = secret();
  if (!key) return null;
  const exp = expiryFrom(now);
  const epoch = await mediaEpoch(now);
  const object = (objectKey: string, lasting: boolean): string | null => {
    if (!OBJECT_KEY.test(objectKey) || objectKey.includes('..')) return null;
    return lasting
      ? `/media/i/${epoch}/${sign(`i:${epoch}:${objectKey}`, key)}/${objectKey}`
      : `/media/s/${epoch}/${exp}/${sign(`s:${epoch}:${exp}:${objectKey}`, key)}/${objectKey}`;
  };
  return {
    object,
    original: (file: MediaFile, lasting: boolean) => (file.blob_key ? object(file.blob_key, lasting) : null),
    expires: exp,
  };
}

/** The addresses of a site without MEDIA_KEY: pages still show, with nothing to play or look at. */
export const NO_MEDIA: MediaUrls & { expires: number } = { object: () => null, original: () => null, expires: 0 };

export type Checked = { key: string; lasting: boolean; expires: number | null } | { error: 'expired' | 'invalid'; lasting?: boolean };

/**
 * The object a /media address names, when its signature holds, it is of the current media epoch and it has
 * not run out. An address of an older epoch counts as run out (the player then asks for a new one).
 */
export async function checkAddress(path: string, now = Date.now()): Promise<Checked> {
  const key = secret();
  if (!key) return { error: 'invalid' };
  const lasting = /^i\/(\d{1,9})\/([\w-]{22})\/(.+)$/.exec(path);
  if (lasting) {
    const [, epochText, sig, objectKey] = lasting;
    if (!OBJECT_KEY.test(objectKey) || objectKey.includes('..') || !same(sig, sign(`i:${epochText}:${objectKey}`, key))) return { error: 'invalid' };
    if (!(await sameEpoch(Number(epochText), now))) return { error: 'expired', lasting: true };
    return { key: objectKey, lasting: true, expires: null };
  }
  const timed = /^s\/(\d{1,9})\/(\d{9,11})\/([\w-]{22})\/(.+)$/.exec(path);
  if (timed) {
    const [, epochText, expText, sig, objectKey] = timed;
    const exp = Number(expText);
    if (!OBJECT_KEY.test(objectKey) || objectKey.includes('..') || !same(sig, sign(`s:${epochText}:${exp}:${objectKey}`, key))) return { error: 'invalid' };
    if (exp * 1000 < now || !(await sameEpoch(Number(epochText), now))) return { error: 'expired', lasting: false };
    return { key: objectKey, lasting: false, expires: exp };
  }
  return { error: 'invalid' };
}

/**
 * An address of the current media epoch. The epoch is read a few seconds apart per Worker instance, so
 * one that differs is read again before the address is turned away (the page may come from an instance
 * that has seen a newer one).
 */
async function sameEpoch(epoch: number, now: number): Promise<boolean> {
  return epoch === (await mediaEpoch(now)) || epoch === (await mediaEpoch(now, true));
}

/** Compare two signatures in constant time. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
