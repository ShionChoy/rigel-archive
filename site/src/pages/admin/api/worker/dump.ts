import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fail, json } from '../../../../lib/api';

// The database for the backup's SQL export. Without ?table: the schema (tables with their CREATE
// statements and row counts, indexes). With ?table=: one page of rows in rowid order (?after=, ?limit=).

interface Entry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

async function schema(db: D1Database) {
  const { results } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name")
    .all<Entry>();
  const tables = results.filter((r) => r.type === 'table' && !r.name.startsWith('_cf_'));
  const indexes = results.filter((r) => r.type === 'index' && tables.some((t) => t.name === r.tbl_name));
  return { tables, indexes };
}

export const GET: APIRoute = async ({ url }) => {
  const { tables, indexes } = await schema(env.DB);
  const table = url.searchParams.get('table');
  if (!table) {
    const counts = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT count(*) AS n FROM "${t.name}"`)));
    return json({
      tables: tables.map((t, i) => ({ name: t.name, sql: t.sql, rows: (counts[i].results[0] as { n: number }).n })),
      indexes: indexes.map((x) => ({ name: x.name, table: x.tbl_name, sql: x.sql })),
    });
  }
  if (!tables.some((t) => t.name === table)) return fail('没有这个表');
  const after = Number(url.searchParams.get('after')) || 0;
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 500));
  const [names, ...rows] = await env.DB.prepare(`SELECT rowid AS _rowid_, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
    .bind(after, limit)
    .raw({ columnNames: true });
  const columns = (names as string[]).slice(1);
  return json({
    columns,
    rows: rows.map((r) => (r as unknown[]).slice(1)),
    last: rows.length === limit ? Number((rows[rows.length - 1] as unknown[])[0]) : null,
  });
};
