import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { json } from '../../../../lib/api';
import { WANTED } from '../../../../lib/processing';

/** Uploaded contents not verified and probed yet (one entry per SHA-256), oldest first. */
export const GET: APIRoute = async ({ url }) => {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const { results } = await env.DB.prepare(
    `SELECT f.sha256, min(f.name) AS name, min(f.ext) AS ext, max(f.size) AS size, count(*) AS files
     FROM files f WHERE ${WANTED.check}
     GROUP BY f.sha256 ORDER BY min(f.created_at) LIMIT ?`,
  )
    .bind(limit)
    .all();
  return json({ jobs: results });
};
