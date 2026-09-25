import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json, readJson } from '../../../../lib/api';
import { shaList, storedSizes } from '../../../../lib/blobs';

/** Which of these contents storage already has, with their sizes. */
export const POST: APIRoute = async ({ request }) => {
  try {
    const sizes = await storedSizes(env.MEDIA, shaList(await readJson(request)));
    return json({ have: Object.fromEntries(sizes) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
