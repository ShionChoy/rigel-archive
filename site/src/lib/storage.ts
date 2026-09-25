// Stored content (R2) that no file references any more, and its cleanup.
//
// Deleting a file keeps its content so the deletion can be undone. Content is cleaned up only when no
// file has referenced it for STORAGE_GRACE_DAYS, counted from the last deletion that released it (or
// from the upload, for content that was stored but never registered).

export interface StoredObject {
  key: string;
  size: number;
  uploaded: string;
}

export interface Unreferenced extends StoredObject {
  since: string;
  purgeAfter: string;
  purgeable: boolean;
}

export async function listObjects(media: R2Bucket, prefix = 'blobs/'): Promise<StoredObject[]> {
  const out: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await media.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export function graceDays(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

export async function storageReport(db: D1Database, media: R2Bucket, grace: number, now = new Date()) {
  const objects = await listObjects(media);
  const { results } = await db.prepare('SELECT DISTINCT blob_key FROM files WHERE blob_key IS NOT NULL').all<{ blob_key: string }>();
  const referenced = new Set(results.map((r) => r.blob_key));
  const loose = objects.filter((o) => !referenced.has(o.key));

  const released = new Map<string, string>();
  for (let i = 0; i < loose.length; i += 90) {
    const chunk = loose.slice(i, i + 90).map((o) => o.key);
    const { results: rows } = await db
      .prepare(
        `SELECT json_extract(before, '$.blob_key') AS key, max(at) AS at FROM revisions
         WHERE entity = 'file' AND action = 'delete' AND json_extract(before, '$.blob_key') IN (${chunk.map(() => '?').join(', ')})
         GROUP BY key`,
      )
      .bind(...chunk)
      .all<{ key: string; at: string }>();
    for (const r of rows) released.set(r.key, r.at);
  }

  const unreferenced: Unreferenced[] = loose.map((o) => {
    const deleted = released.get(o.key);
    const since = deleted && deleted > o.uploaded ? deleted : o.uploaded;
    const purgeAfter = new Date(Date.parse(since) + grace * 86_400_000).toISOString();
    return { ...o, since, purgeAfter, purgeable: purgeAfter <= now.toISOString() };
  });
  unreferenced.sort((a, b) => a.purgeAfter.localeCompare(b.purgeAfter));
  return {
    objects: objects.length,
    bytes: objects.reduce((n, o) => n + o.size, 0),
    unreferenced,
  };
}

/**
 * Delete the unreferenced content whose grace period is over, with everything made from it (derived
 * files, fingerprint, matches, task records). Rechecks references right before.
 */
export async function purge(db: D1Database, media: R2Bucket, grace: number): Promise<{ count: number; bytes: number }> {
  const report = await storageReport(db, media, grace);
  const doomed = report.unreferenced.filter((o) => o.purgeable);
  for (let i = 0; i < doomed.length; i += 1000) await media.delete(doomed.slice(i, i + 1000).map((o) => o.key));
  const shas = doomed.map((o) => o.key.replace(/^blobs\//, ''));
  for (let i = 0; i < shas.length; i += 200) {
    const list = JSON.stringify(shas.slice(i, i + 200));
    // Derived files no other content still points at (a WAV and its FLAC share stream files).
    const { results } = await db
      .prepare(
        `SELECT DISTINCT d.key FROM derived d WHERE d.sha256 IN (SELECT value FROM json_each(?1)) AND d.key LIKE 'derived/%'
           AND NOT EXISTS (SELECT 1 FROM derived o WHERE o.key = d.key AND o.sha256 NOT IN (SELECT value FROM json_each(?1)))`,
      )
      .bind(list)
      .all<{ key: string }>();
    for (let j = 0; j < results.length; j += 1000) await media.delete(results.slice(j, j + 1000).map((r) => r.key));
    await db.batch([
      db.prepare('DELETE FROM derived WHERE sha256 IN (SELECT value FROM json_each(?))').bind(list),
      db.prepare('DELETE FROM fingerprints WHERE sha256 IN (SELECT value FROM json_each(?))').bind(list),
      db.prepare('DELETE FROM media_tasks WHERE sha256 IN (SELECT value FROM json_each(?))').bind(list),
      db.prepare('DELETE FROM acoustic_matches WHERE a IN (SELECT value FROM json_each(?1)) OR b IN (SELECT value FROM json_each(?1))').bind(list),
    ]);
  }
  return { count: doomed.length, bytes: doomed.reduce((n, o) => n + o.size, 0) };
}

/**
 * Files whose content belongs in storage but is not there yet (`ra push` uploads them from the local
 * copy). Everything is kept, third-party files included (the site is also an archive; storage is
 * private, and what the public site shows is decided by rights, not by what is stored). Only files
 * ignored, or suggested to be ignored (system junk such as Thumbs.db), stay out; filing such a file
 * differently later makes it wanted again.
 */
export const WANTED = `blob_key IS NULL AND sha256 IS NOT NULL AND state != 'ignored'
  AND NOT (state = 'inbox' AND coalesce(json_extract(suggest, '$.state'), '') = 'ignored')`;

export async function wantedTotals(db: D1Database): Promise<{ n: number; bytes: number }> {
  const row = await db
    .prepare(`SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM (SELECT sha256, max(size) AS size FROM files WHERE ${WANTED} GROUP BY sha256)`)
    .first<{ n: number; bytes: number }>();
  return row ?? { n: 0, bytes: 0 };
}
