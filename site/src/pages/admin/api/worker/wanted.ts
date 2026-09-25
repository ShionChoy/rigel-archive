import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SHA256_HEX, json } from '../../../../lib/api';
import { WANTED } from '../../../../lib/storage';

/** Contents `ra push` should upload, one entry per SHA-256, in SHA-256 order (page with ?after=). */
export const GET: APIRoute = async ({ url }) => {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  const after = url.searchParams.get('after') ?? '';
  const { results } = await env.DB.prepare(
    `SELECT sha256, max(size) AS size, min(name) AS name, min(ext) AS ext FROM files
     WHERE sha256 > ? AND ${WANTED} GROUP BY sha256 ORDER BY sha256 LIMIT ?`,
  )
    .bind(SHA256_HEX.test(after) ? after : '', limit)
    .all<{ sha256: string; size: number; name: string; ext: string }>();
  return json({ items: results, next: results.length === limit ? results[results.length - 1].sha256 : null });
};
