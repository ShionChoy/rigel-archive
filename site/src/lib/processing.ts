// The processing queue: what the processing program (the container, or `uv run ra worker`) still has to
// do for stored contents, its claims and results (table media_tasks), and what it made (tables derived,
// fingerprints, acoustic_matches). See tools/ra/src/ra/processing.py for the other side.

import { DERIVED_KEY } from './blobs';

/** Versions of the program's rules; tools/ra has the same numbers (a test compares them). */
export const TASK_VERSIONS = { check: 1, derive: 2, fingerprint: 1 } as const;
export type Task = keyof typeof TASK_VERSIONS;
export const TASKS = Object.keys(TASK_VERSIONS) as Task[];

export const MAX_ATTEMPTS = 3;
/**
 * A claim not renewed for this long is taken as a crashed or restarted run and may be claimed again. The
 * processing program renews its claims every few minutes while it works (long videos take an hour).
 */
export const STALE_MINUTES = 20;
/** A failed content waits this long before the next try. */
export const RETRY_AFTER_MINUTES = 60;
/** Shorter audio is left alone unless it is filed under a release (BMS key sounds, jingles in archives); so
 * is shorter video for fingerprints (a few seconds are too short to compare). */
export const MIN_AUDIO_SECONDS = 30;

const ago = (minutes: number) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${minutes} minutes')`;

/**
 * Derive version 2 only adds «embed» (a 1600 px JPEG of a picture of 12 MB or more, for embedding as a
 * cover): contents derived by version 1 are asked again only when they are such pictures.
 */
export const EMBED_SQL = "(f.kind = 'image' AND f.size >= 12000000)";

/** Contents that are not waiting for this task: done, given up, being worked on, or failed a moment ago. */
function settled(task: Task): string {
  const v = TASK_VERSIONS[task];
  const current = task === 'derive' ? `(t.version >= ${v} OR (t.version >= 1 AND NOT ${EMBED_SQL}))` : `t.version >= ${v}`;
  return `EXISTS (SELECT 1 FROM media_tasks t WHERE t.sha256 = f.sha256 AND t.task = '${task}' AND (
    (t.state = 'done' AND ${current})
    OR (t.attempts >= ${MAX_ATTEMPTS} AND ${current})
    OR (t.state = 'running' AND t.started_at > ${ago(STALE_MINUTES)})
    OR (t.state = 'failed' AND t.updated_at > ${ago(RETRY_AFTER_MINUTES)})))`;
}

// Stored, readable, not ignored (or suggested to be ignored), not inside an archive kept whole and, for
// uploads, already checked.
const USABLE = `f.blob_key IS NOT NULL AND f.sha256 IS NOT NULL AND f.state != 'ignored' AND f.sealed_in IS NULL
  AND NOT (f.state = 'inbox' AND coalesce(json_extract(f.suggest, '$.state'), '') = 'ignored')
  AND json_extract(f.format, '$.probe_error') IS NULL AND json_extract(f.format, '$.upload_error') IS NULL
  AND (f.origin != 'upload' OR f.checked_at IS NOT NULL)`;
const LONG_ENOUGH = `(coalesce(json_extract(f.format, '$.duration'), 0) >= ${MIN_AUDIO_SECONDS} OR f.release_id IS NOT NULL)`;

/** Per task: the files whose content still needs it (one entry per SHA-256 after grouping). */
export const WANTED: Record<Task, string> = {
  check: `f.origin = 'upload' AND f.checked_at IS NULL AND f.sha256 IS NOT NULL AND f.blob_key IS NOT NULL AND NOT ${settled('check')}`,
  derive: `${USABLE} AND f.kind IN ('audio', 'video', 'image') AND (f.kind != 'audio' OR ${LONG_ENOUGH}) AND NOT ${settled('derive')}`,
  fingerprint: `${USABLE} AND f.kind IN ('audio', 'video') AND ${LONG_ENOUGH}
    AND json_extract(f.format, '$.duration') > 0 AND NOT ${settled('fingerprint')}`,
};

export async function pendingCounts(db: D1Database): Promise<Record<Task, number>> {
  const rows = await db.batch(
    TASKS.map((task) => db.prepare(`SELECT count(DISTINCT f.sha256) AS n FROM files f WHERE ${WANTED[task]}`)),
  );
  return Object.fromEntries(TASKS.map((task, i) => [task, (rows[i].results[0] as { n: number }).n])) as Record<Task, number>;
}

export interface TaskItem {
  sha256: string;
  name: string;
  ext: string;
  kind: string;
  size: number;
  format: unknown;
  pcm_md5: string | null;
  shared?: Record<string, { key: string; size: number; info: unknown }>;
}

/** Which contents a request asks for: videos only, everything else, or all (the processing program derives
 * videos in a lane of their own, so that a long live recording does not hold up the rest). */
export type TaskKind = 'video' | 'other' | null;

/** The next contents for a task (uploads first, newest first). */
export async function taskItems(db: D1Database, task: Exclude<Task, 'check'>, limit: number, kind: TaskKind = null): Promise<TaskItem[]> {
  const only = kind === 'video' ? "AND f.kind = 'video'" : kind === 'other' ? "AND f.kind != 'video'" : '';
  const { results } = await db
    .prepare(
      `SELECT f.sha256, min(f.name) AS name, min(f.ext) AS ext, min(f.kind) AS kind, max(f.size) AS size,
              max(f.format) AS format, max(f.pcm_md5) AS pcm_md5
       FROM files f WHERE ${WANTED[task]} ${only}
       GROUP BY f.sha256 ORDER BY max(f.origin = 'upload') DESC, max(f.created_at) DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Omit<TaskItem, 'format'> & { format: string | null }>();
  const items: TaskItem[] = results.map((r) => ({ ...r, format: r.format ? JSON.parse(r.format) : null }));
  if (task !== 'derive') return items;

  // Contents with the same decoded audio share one set of stream files: hand over what already exists.
  const pcm = [...new Set(items.map((i) => i.pcm_md5).filter((p): p is string => !!p))];
  if (pcm.length === 0) return items;
  const { results: done } = await db
    .prepare(
      `SELECT DISTINCT f.pcm_md5, d.sha256, d.kind, d.key, d.size, d.info FROM derived d
       JOIN files f ON f.sha256 = d.sha256
       WHERE f.pcm_md5 IN (SELECT value FROM json_each(?)) AND d.kind IN ('stream', 'aac', 'wave')`,
    )
    .bind(JSON.stringify(pcm))
    .all<{ pcm_md5: string; sha256: string; kind: string; key: string; size: number; info: string | null }>();
  for (const item of items) {
    if (!item.pcm_md5) continue;
    const mine = done.filter((d) => d.pcm_md5 === item.pcm_md5 && d.sha256 !== item.sha256);
    const source = mine.find((d) => d.kind === 'stream')?.sha256 ?? mine[0]?.sha256;
    if (!source) continue;
    item.shared = Object.fromEntries(
      mine.filter((d) => d.sha256 === source).map((d) => [d.kind, { key: d.key, size: d.size, info: d.info ? JSON.parse(d.info) : null }]),
    );
  }
  return items;
}

/** Take a content for a task; false when it is being worked on, done, or given up. */
export async function claim(db: D1Database, task: Task, sha256: string, version: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO media_tasks (sha256, task, version, state, attempts, started_at, updated_at)
       VALUES (?1, ?2, ?3, 'running', 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT (sha256, task) DO UPDATE SET
         attempts = CASE WHEN media_tasks.version < excluded.version THEN 1 ELSE media_tasks.attempts + 1 END,
         version = excluded.version, state = 'running', error = NULL,
         started_at = excluded.started_at, updated_at = excluded.updated_at
       WHERE NOT (media_tasks.state = 'running' AND media_tasks.started_at > ${ago(STALE_MINUTES)})
         AND NOT (media_tasks.state = 'done' AND media_tasks.version >= excluded.version)
         AND NOT (media_tasks.attempts >= ${MAX_ATTEMPTS} AND media_tasks.version >= excluded.version)`,
    )
    .bind(sha256, task, version)
    .run();
  return result.meta.changes > 0;
}

/**
 * Claims that lapsed on the last try (the container was restarted or stopped three times while working on
 * the content) would otherwise sit as "running" for ever, neither waiting nor failed: mark them failed so
 * that they show up in the failed list and can be retried from there. Run by the 10-minute cron.
 */
export async function failAbandoned(db: D1Database): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE media_tasks SET state = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE state = 'running' AND attempts >= ${MAX_ATTEMPTS} AND started_at <= ${ago(STALE_MINUTES)}`,
    )
    .bind(`处理中途中断了 ${MAX_ATTEMPTS} 次（处理程序重启或被停止）`)
    .run();
  return r.meta.changes;
}

/** The processing program is still working on a claimed content. */
export async function touch(db: D1Database, task: Task, sha256: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE media_tasks SET started_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE sha256 = ? AND task = ? AND state = 'running'`,
    )
    .bind(sha256, task)
    .run();
  return r.meta.changes > 0;
}

export function finishStatement(db: D1Database, task: Task, sha256: string, version: number, error: string | null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO media_tasks (sha256, task, version, state, attempts, error, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT (sha256, task) DO UPDATE SET version = excluded.version, state = excluded.state,
         error = excluded.error, updated_at = excluded.updated_at`,
    )
    .bind(sha256, task, version, error ? 'failed' : 'done', error ? error.slice(0, 500) : null);
}

export interface DerivedOutput {
  kind: string;
  key: string;
  size: number;
  info: unknown;
}

export const DERIVED_KINDS = ['stream', 'aac', 'wave', 'img240', 'img640', 'img1600', 'embed', 'video', 'poster'] as const;

/** Validate the derived files a derive run reports, checking each is in storage with its size. */
export async function checkOutputs(media: R2Bucket, raw: unknown): Promise<DerivedOutput[]> {
  if (!Array.isArray(raw)) throw new Error('outputs 必须是列表');
  const outputs = raw.map((o) => {
    const x = o as Record<string, unknown>;
    const out = { kind: String(x.kind ?? ''), key: String(x.key ?? ''), size: Number(x.size), info: x.info ?? null };
    if (!(DERIVED_KINDS as readonly string[]).includes(out.kind)) throw new Error(`未知的衍生文件类型：${out.kind}`);
    // A derived file, or an original that streams as it is (its own, or one with the same audio).
    if (!DERIVED_KEY.test(out.key) && !/^blobs\/[0-9a-f]{64}$/.test(out.key)) throw new Error(`衍生文件位置无效：${out.key}`);
    return out;
  });
  if (new Set(outputs.map((o) => o.kind)).size !== outputs.length) throw new Error('同一类衍生文件报了两次');
  const heads = await Promise.all(outputs.map((o) => media.head(o.key)));
  heads.forEach((h, i) => {
    if (!h) throw new Error(`存储里没有 ${outputs[i].key}`);
    if (h.size !== outputs[i].size) throw new Error(`${outputs[i].key} 的大小与报告不符`);
  });
  return outputs;
}

/**
 * Save a content's derived files (replacing the ones from an earlier run) and mark the task done.
 * Stored files the new set no longer uses are deleted, unless another content still points at them.
 */
export async function saveDerived(db: D1Database, media: R2Bucket, sha256: string, version: number, outputs: DerivedOutput[]) {
  const { results: before } = await db.prepare('SELECT key FROM derived WHERE sha256 = ?').bind(sha256).all<{ key: string }>();
  await db.batch([
    db.prepare('DELETE FROM derived WHERE sha256 = ?').bind(sha256),
    ...outputs.map((o) =>
      db.prepare('INSERT INTO derived (sha256, kind, key, size, info) VALUES (?, ?, ?, ?, ?)')
        .bind(sha256, o.kind, o.key, o.size, o.info == null ? null : JSON.stringify(o.info)),
    ),
    finishStatement(db, 'derive', sha256, version, null),
  ]);
  const dropped = before.map((b) => b.key).filter((k) => k.startsWith('derived/') && !outputs.some((o) => o.key === k));
  for (const key of dropped) {
    const still = await db.prepare('SELECT 1 FROM derived WHERE key = ? LIMIT 1').bind(key).first();
    if (!still) await media.delete(key);
  }
}

export interface DerivedRow {
  sha256: string;
  kind: string;
  key: string;
  size: number;
  info: string | null;
}

/** Derived files by content, for pages that show many files. */
export async function derivedFor(db: D1Database, shas: (string | null)[]): Promise<Map<string, Map<string, DerivedRow>>> {
  const list = [...new Set(shas.filter((s): s is string => !!s))];
  const out = new Map<string, Map<string, DerivedRow>>();
  for (let i = 0; i < list.length; i += 500) {
    const { results } = await db
      .prepare('SELECT sha256, kind, key, size, info FROM derived WHERE sha256 IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(list.slice(i, i + 500)))
      .all<DerivedRow>();
    for (const r of results) {
      if (!out.has(r.sha256)) out.set(r.sha256, new Map());
      out.get(r.sha256)!.set(r.kind, r);
    }
  }
  return out;
}

export const mediaUrl = (key: string) => `/admin/media/${key}`;

/** Forget a content's results so the processing program does the task again. */
export async function redo(db: D1Database, task: Task, sha256: string): Promise<void> {
  await db.prepare('DELETE FROM media_tasks WHERE sha256 = ? AND task = ?').bind(sha256, task).run();
}
