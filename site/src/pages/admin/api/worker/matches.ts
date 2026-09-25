import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, fail, json, readJson } from '../../../../lib/api';

interface Pair {
  a: string;
  b: string;
  score: number;
  offset_ms: number;
  matched_ms: number;
}

function parsePairs(raw: unknown): Pair[] {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error('pairs 必须是最多 1000 项的列表');
  return raw.map((x) => {
    const p = x as Record<string, unknown>;
    const pair = { a: String(p.a), b: String(p.b), score: Number(p.score), offset_ms: Number(p.offset_ms), matched_ms: Number(p.matched_ms) };
    if (!SHA256_HEX.test(pair.a) || !SHA256_HEX.test(pair.b) || !(pair.a < pair.b)) throw new Error('配对无效');
    if (!(pair.score >= 0 && pair.score <= 1) || !Number.isInteger(pair.offset_ms) || !Number.isInteger(pair.matched_ms)) throw new Error('配对数据无效');
    return pair;
  });
}

/** Replace the acoustic matches of some contents (or of all, `all: true`) with newly found pairs. */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    const pairs = parsePairs(body.pairs);
    const shas = body.all === true ? null : Array.isArray(body.shas) ? body.shas.map(String) : [];
    if (shas && !shas.every((s) => SHA256_HEX.test(s))) return fail('SHA-256 无效');
    const statements: D1PreparedStatement[] = [];
    if (shas === null) statements.push(env.DB.prepare('DELETE FROM acoustic_matches'));
    else if (shas.length) {
      statements.push(
        env.DB.prepare('DELETE FROM acoustic_matches WHERE a IN (SELECT value FROM json_each(?1)) OR b IN (SELECT value FROM json_each(?1))')
          .bind(JSON.stringify(shas)),
      );
    }
    for (let i = 0; i < pairs.length; i += 200) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO acoustic_matches (a, b, score, offset_ms, matched_ms)
           SELECT json_extract(j.value, '$.a'), json_extract(j.value, '$.b'), json_extract(j.value, '$.score'),
                  json_extract(j.value, '$.offset_ms'), json_extract(j.value, '$.matched_ms') FROM json_each(?) j
           WHERE true
           ON CONFLICT (a, b) DO UPDATE SET score = excluded.score, offset_ms = excluded.offset_ms,
             matched_ms = excluded.matched_ms, created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
        ).bind(JSON.stringify(pairs.slice(i, i + 200))),
      );
    }
    if (statements.length) await env.DB.batch(statements);
    return json({ saved: pairs.length });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
};
