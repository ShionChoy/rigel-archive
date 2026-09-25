import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, fail, json, readJson } from '../../../../lib/api';
import { parseMembers, registerMembers } from '../../../../lib/unpack';

/** `ra worker` has unpacked an uploaded archive and stored its members' contents: add the members. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await readJson(request);
    const sha256 = String(body.sha256 ?? '');
    if (!SHA256_HEX.test(sha256)) return fail('SHA-256 无效');
    const archives = await registerMembers(env.DB, locals.admin!.email, sha256, parseMembers(body.members));
    return json({ archives });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
