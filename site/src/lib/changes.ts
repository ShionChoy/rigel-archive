// Every admin edit goes through a ChangeSet: the row change and its revision are written in the same
// D1 batch (a transaction), and all revisions of one operation share a batch id so it can be undone.

import { N_, UserError, undoSummary } from './i18n';

type Row = Record<string, unknown>;

interface EntitySpec {
  table: string;
  key: readonly string[];
  fields: readonly string[]; // editable in the admin
  columns?: readonly string[]; // every column, when rows are created or deleted with machine-set columns
  touch?: boolean; // table has updated_at
}

/** Every column of files (migrations 0001, 0003, 0004); a test in tools/ra compares this with the schema. */
export const FILE_COLUMNS = [
  'id', 'origin', 'source_path', 'dir', 'member_of', 'member_path', 'name', 'ext', 'size', 'mtime', 'sha256',
  'blob_key', 'kind', 'format', 'pcm_md5', 'rights', 'state', 'release_id', 'slot', 'track_id', 'role', 'dup_of',
  'suggest', 'download_name', 'note', 'uploaded_by', 'created_at', 'updated_at', 'checked_at', 'source_seen',
  'replaces',
] as const;

export const ENTITIES = {
  release: {
    table: 'releases',
    key: ['id'],
    fields: [
      'catalog_no', 'era_id', 'kind', 'series', 'title', 'title_reading', 'release_date', 'event',
      'track_count', 'price', 'aliases', 'links', 'description', 'note', 'cover_file_id', 'state',
    ],
    touch: true,
  },
  release_slot: {
    table: 'release_slots',
    key: ['release_id', 'slot'],
    fields: ['status', 'planned_date', 'note'],
  },
  file: {
    table: 'files',
    key: ['id'],
    fields: ['release_id', 'slot', 'track_id', 'role', 'rights', 'state', 'dup_of', 'download_name', 'note'],
    columns: FILE_COLUMNS,
    touch: true,
  },
  translation: {
    table: 'translations',
    key: ['entity', 'entity_id', 'field', 'lang'],
    fields: ['value', 'status'],
  },
  track: {
    table: 'tracks',
    key: ['id'],
    fields: ['release_id', 'disc', 'position', 'title', 'song_id', 'version_label', 'duration_ms', 'credits', 'note'],
  },
  song: {
    table: 'songs',
    key: ['id'],
    fields: ['title', 'note'],
    columns: ['id', 'title', 'note', 'created_at'],
  },
  admin: {
    table: 'admins',
    key: ['email'],
    fields: ['name', 'role', 'lang'],
    columns: ['email', 'name', 'role', 'lang', 'created_at'],
  },
} as const satisfies Record<string, EntitySpec>;

export type EntityName = keyof typeof ENTITIES;

export const ENTITY_LABELS: Record<EntityName, string> = {
  release: N_('作品'),
  release_slot: N_('版本栏位'),
  file: N_('文件'),
  translation: N_('译名'),
  track: N_('曲目'),
  song: N_('单曲'),
  admin: N_('管理组成员'),
};

// Keeps each statement well under D1's 100 bound-parameter limit.
const CHUNK = 60;
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

function spec(entity: EntityName): EntitySpec {
  return ENTITIES[entity];
}

export function isEntity(value: string): value is EntityName {
  return Object.hasOwn(ENTITIES, value);
}

export function entityId(entity: EntityName, key: Row): string {
  return spec(entity).key.map((k) => String(key[k])).join('/');
}

export function parseEntityId(entity: EntityName, id: string): Row {
  const keys = spec(entity).key;
  const parts = id.split('/');
  if (parts.length !== keys.length) throw new Error(`bad ${entity} id: ${id}`);
  return Object.fromEntries(keys.map((k, i) => [k, parts[i]]));
}

/** D1 returns INTEGER columns as numbers while forms send strings; compare loosely. */
export function same(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return String(x) === String(y);
}

function rowColumns(entity: EntityName): readonly string[] {
  const s = spec(entity);
  return s.columns ?? [...s.key, ...s.fields];
}

function checkFields(entity: EntityName, fields: string[]) {
  const allowed = spec(entity).fields as readonly string[];
  for (const f of fields) {
    if (!allowed.includes(f)) throw new Error(`${entity}.${f} is not editable`);
  }
}

function keyWhere(entity: EntityName): string {
  return spec(entity).key.map((k) => `${k} = ?`).join(' AND ');
}

function keyValues(entity: EntityName, key: Row): unknown[] {
  return spec(entity).key.map((k) => key[k]);
}

export class ChangeSet {
  private statements: D1PreparedStatement[] = [];
  private countedUpdates: number[] = []; // indexes of set-based updates whose row counts we report
  private rowChanges = 0;

  /** Pass batchId to add to an earlier batch (an upload session registers its files one by one). */
  constructor(
    private db: D1Database,
    private actor: string,
    readonly summary: string,
    readonly batchId: string = crypto.randomUUID(),
  ) {}

  get size(): number {
    return this.statements.length;
  }

  private revision(entity: EntityName, id: string, action: 'create' | 'update' | 'delete', before: Row | null, after: Row | null) {
    this.statements.push(
      this.db
        .prepare(
          `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(this.actor, this.batchId, this.summary, entity, id, action,
          before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null),
    );
  }

  async read(entity: EntityName, key: Row, fields?: readonly string[]): Promise<Row | null> {
    const s = spec(entity);
    const cols = fields ?? rowColumns(entity);
    return this.db
      .prepare(`SELECT ${cols.join(', ')} FROM ${s.table} WHERE ${keyWhere(entity)}`)
      .bind(...keyValues(entity, key))
      .first<Row>();
  }

  /** Update one row; only fields that actually change are written and recorded. */
  async update(entity: EntityName, key: Row, patch: Row): Promise<boolean> {
    const fields = Object.keys(patch);
    checkFields(entity, fields);
    const current = await this.read(entity, key, fields);
    if (!current) throw new Error(`${entity} ${entityId(entity, key)} not found`);
    return this.updateKnown(entity, key, current, patch);
  }

  /** Like update(), with the current values already loaded by the caller. */
  updateKnown(entity: EntityName, key: Row, current: Row, patch: Row): boolean {
    const s = spec(entity);
    const changed = Object.keys(patch).filter((f) => !same(current[f], patch[f]));
    checkFields(entity, changed);
    if (changed.length === 0) return false;
    const before = Object.fromEntries(changed.map((f) => [f, current[f] ?? null]));
    const after = Object.fromEntries(changed.map((f) => [f, patch[f] ?? null]));
    const sets = changed.map((f) => `${f} = ?`);
    if (s.touch) sets.push(`updated_at = ${NOW}`);
    this.statements.push(
      this.db
        .prepare(`UPDATE ${s.table} SET ${sets.join(', ')} WHERE ${keyWhere(entity)}`)
        .bind(...changed.map((f) => patch[f] ?? null), ...keyValues(entity, key)),
    );
    this.revision(entity, entityId(entity, key), 'update', before, after);
    this.rowChanges += 1;
    return true;
  }

  create(entity: EntityName, row: Row) {
    const s = spec(entity);
    const allowed = rowColumns(entity);
    const cols = Object.keys(row).filter((c) => allowed.includes(c));
    this.statements.push(
      this.db
        .prepare(`INSERT INTO ${s.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...cols.map((c) => row[c] ?? null)),
    );
    this.revision(entity, entityId(entity, row), 'create', null, Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
    this.rowChanges += 1;
  }

  async delete(entity: EntityName, key: Row): Promise<boolean> {
    const current = await this.read(entity, key);
    if (!current) return false;
    this.statements.push(
      this.db.prepare(`DELETE FROM ${spec(entity).table} WHERE ${keyWhere(entity)}`).bind(...keyValues(entity, key)),
    );
    this.revision(entity, entityId(entity, key), 'delete', current, null);
    this.rowChanges += 1;
    return true;
  }

  /**
   * Apply the same patch to many files with two set-based statements per chunk: the revision rows are
   * copied from the current values first, then the rows are updated. Files already matching the patch
   * are skipped by both statements.
   */
  updateFiles(ids: string[], patch: Row) {
    const fields = Object.keys(patch);
    checkFields('file', fields);
    if (fields.length === 0) return;
    const values = fields.map((f) => patch[f] ?? null);
    const unchanged = fields.map((f) => `${f} IS ?`).join(' AND ');
    const beforeJson = `json_object(${fields.map((f) => `'${f}', ${f}`).join(', ')})`;
    const afterJson = `json_object(${fields.map((f) => `'${f}', ?`).join(', ')})`;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const where = `id IN (${chunk.map(() => '?').join(', ')}) AND NOT (${unchanged})`;
      this.statements.push(
        this.db
          .prepare(
            `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
             SELECT ?, ?, ?, 'file', id, 'update', ${beforeJson}, ${afterJson} FROM files WHERE ${where}`,
          )
          .bind(this.actor, this.batchId, this.summary, ...values, ...chunk, ...values),
      );
      this.countedUpdates.push(this.statements.length);
      this.statements.push(
        this.db
          .prepare(`UPDATE files SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ${NOW} WHERE ${where}`)
          .bind(...values, ...chunk, ...values),
      );
    }
  }

  /**
   * Delete files with set-based statements, recording each whole row so the deletion can be undone.
   * `levels` lists archives before their members (level 0 = top): undo re-inserts in revision order,
   * so parents come back before the members that reference them.
   */
  deleteFiles(levels: string[][]) {
    const row = `json_object(${FILE_COLUMNS.map((c) => `'${c}', ${c}`).join(', ')})`;
    for (const ids of levels) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        this.statements.push(
          this.db
            .prepare(
              `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
               SELECT ?, ?, ?, 'file', id, 'delete', ${row}, NULL FROM files WHERE id IN (${chunk.map(() => '?').join(', ')})`,
            )
            .bind(this.actor, this.batchId, this.summary, ...chunk),
        );
      }
    }
    for (const ids of [...levels].reverse()) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        this.countedUpdates.push(this.statements.length);
        this.statements.push(this.db.prepare(`DELETE FROM files WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk));
      }
    }
  }

  /**
   * Create many files with two set-based statements per chunk, the rows travelling as one JSON
   * parameter (D1 allows 100 bound parameters, but each may hold up to 2 MB). Rows are inserted in
   * the given order, so archives must come before their members.
   */
  createFiles(rows: Row[]) {
    const cols = FILE_COLUMNS.filter((c) => c !== 'created_at' && c !== 'updated_at');
    const clean = rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c] ?? null])));
    for (let i = 0; i < clean.length; i += 200) {
      const chunk = JSON.stringify(clean.slice(i, i + 200));
      this.statements.push(
        this.db
          .prepare(
            `INSERT INTO files (${cols.join(', ')})
             SELECT ${cols.map((c) => `json_extract(j.value, '$.${c}')`).join(', ')} FROM json_each(?) j ORDER BY j.key`,
          )
          .bind(chunk),
      );
      this.statements.push(
        this.db
          .prepare(
            `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
             SELECT ?, ?, ?, 'file', json_extract(j.value, '$.id'), 'create', NULL, j.value FROM json_each(?) j ORDER BY j.key`,
          )
          .bind(this.actor, this.batchId, this.summary, chunk),
      );
    }
    this.rowChanges += clean.length;
  }

  push(statement: D1PreparedStatement) {
    this.statements.push(statement);
  }

  /** Runs everything in one D1 batch. Returns the number of rows changed. */
  async commit(): Promise<number> {
    if (this.statements.length === 0) return 0;
    const results = await this.db.batch(this.statements);
    const bulk = this.countedUpdates.reduce((n, i) => n + (results[i]?.meta.changes ?? 0), 0);
    return this.rowChanges + bulk;
  }
}

interface RevisionRow {
  id: number;
  summary: string;
  entity: string;
  entity_id: string;
  action: 'create' | 'update' | 'delete';
  before: string | null;
  after: string | null;
  reverted_by_batch: string | null;
}

export type UndoResult = { ok: true; count: number; batchId: string } | { ok: false; reason: UserError };

/**
 * Undo one batch. Refuses when a later edit has changed any of the same fields.
 * `media` lets the undo of a file deletion check that the stored content has not been cleaned up yet.
 */
export async function undoBatch(db: D1Database, actor: string, batchId: string, media?: R2Bucket): Promise<UndoResult> {
  const { results: revs } = await db
    .prepare('SELECT id, summary, entity, entity_id, action, before, after, reverted_by_batch FROM revisions WHERE batch_id = ? ORDER BY id DESC LIMIT 301')
    .bind(batchId)
    .all<RevisionRow>();
  if (revs.length === 0) return { ok: false, reason: new UserError('找不到这次修改') };
  if (revs.some((r) => r.reverted_by_batch)) return { ok: false, reason: new UserError('这次修改已经撤销过') };
  const onlyFiles = await db
    .prepare("SELECT NOT EXISTS (SELECT 1 FROM revisions WHERE batch_id = ? AND entity != 'file') AS yes")
    .bind(batchId)
    .first<{ yes: number }>();
  if (onlyFiles?.yes) return undoFileBatch(db, actor, batchId, revs[0].summary, media);
  if (revs.length > 300) return { ok: false, reason: new UserError('这次修改太大（超过 {n} 处），不能自动撤销', { n: 300 }) };

  const cs = new ChangeSet(db, actor, undoSummary(revs[0].summary));
  for (const rev of revs) {
    if (!isEntity(rev.entity)) return { ok: false, reason: new UserError('未知的记录类型 {entity}', { entity: rev.entity }) };
    const entity = rev.entity;
    const key = parseEntityId(entity, rev.entity_id);
    const before = rev.before ? (JSON.parse(rev.before) as Row) : null;
    const after = rev.after ? (JSON.parse(rev.after) as Row) : null;

    if (rev.action === 'update' && before && after) {
      const current = await cs.read(entity, key, Object.keys(after));
      if (!current || Object.keys(after).some((f) => !same(current[f], after[f]))) {
        return { ok: false, reason: new UserError('{entity} {id} 之后又被修改过，不能自动撤销', { entity: ENTITY_LABELS[entity], id: rev.entity_id }) };
      }
      cs.updateKnown(entity, key, current, before);
    } else if (rev.action === 'create') {
      if (!(await cs.delete(entity, key))) {
        return { ok: false, reason: new UserError('{entity} {id} 已不存在', { entity: ENTITY_LABELS[entity], id: rev.entity_id }) };
      }
    } else if (rev.action === 'delete' && before) {
      if (await cs.read(entity, key)) {
        return { ok: false, reason: new UserError('{entity} {id} 已被重新创建', { entity: ENTITY_LABELS[entity], id: rev.entity_id }) };
      }
      cs.create(entity, before);
    }
  }
  markUndone(cs, db, batchId);
  const count = await cs.commit();
  return { ok: true, count, batchId: cs.batchId };
}

function markUndone(cs: ChangeSet, db: D1Database, batchId: string) {
  cs.push(db.prepare('UPDATE revisions SET reverted_by_batch = ? WHERE batch_id = ?').bind(cs.batchId, batchId));
  // Undoing an undo re-applies the original change, so the original is no longer marked as undone.
  cs.push(db.prepare('UPDATE revisions SET reverted_by_batch = NULL WHERE reverted_by_batch = ?').bind(batchId));
}

/** The value of files.<field> for a field named in a json_each row `j` (editable fields only). */
const FILE_FIELD = `CASE j.key ${ENTITIES.file.fields.map((f) => `WHEN '${f}' THEN f.${f}`).join(' ')} END`;
const FILE_EDITABLE = ENTITIES.file.fields.map((f) => `'${f}'`).join(', ');

/**
 * Undo a batch of file changes with a fixed number of set-based statements, however many files it
 * touched (an upload session, a bulk accept over a whole archive, a deletion with its members).
 */
async function undoFileBatch(db: D1Database, actor: string, batchId: string, summary: string, media?: R2Bucket): Promise<UndoResult> {
  const conflict = await db
    .prepare(
      `SELECT r.entity_id, r.action FROM revisions r LEFT JOIN files f ON f.id = r.entity_id
       WHERE r.batch_id = ?1 AND (
         (r.action = 'update' AND (f.id IS NULL OR EXISTS (
            SELECT 1 FROM json_each(r.after) j WHERE ${FILE_FIELD} IS NOT j.value)))
         OR (r.action = 'create' AND (f.id IS NULL OR EXISTS (
            SELECT 1 FROM json_each(r.after) j WHERE j.key IN (${FILE_EDITABLE}) AND ${FILE_FIELD} IS NOT j.value)))
         OR (r.action = 'delete' AND f.id IS NOT NULL)
       ) LIMIT 1`,
    )
    .bind(batchId)
    .first<{ entity_id: string; action: string }>();
  if (conflict) {
    const text = conflict.action === 'delete' ? N_('文件 {id} 已被重新创建，不能自动撤销') : N_('文件 {id} 之后又被修改或删除过，不能自动撤销');
    return { ok: false, reason: new UserError(text, { id: conflict.entity_id }) };
  }

  if (media) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT json_extract(before, '$.blob_key') AS key FROM revisions
         WHERE batch_id = ? AND action = 'delete' AND json_extract(before, '$.blob_key') IS NOT NULL`,
      )
      .bind(batchId)
      .all<{ key: string }>();
    for (const { key } of results) {
      if (!(await media.head(key))) return { ok: false, reason: new UserError('存储里的文件 {key} 已被清理，不能恢复', { key }) };
    }
  }

  const cs = new ChangeSet(db, actor, undoSummary(summary));
  const row = `json_object(${FILE_COLUMNS.map((c) => `'${c}', f.${c}`).join(', ')})`;
  // The inverse revisions, in the original order so a later undo of this undo restores parents first.
  cs.push(
    db
      .prepare(
        `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
         SELECT ?1, ?2, ?3, 'file', r.entity_id,
                CASE r.action WHEN 'create' THEN 'delete' WHEN 'delete' THEN 'create' ELSE 'update' END,
                CASE r.action WHEN 'create' THEN (SELECT ${row} FROM files f WHERE f.id = r.entity_id) WHEN 'delete' THEN NULL ELSE r.after END,
                CASE r.action WHEN 'create' THEN NULL ELSE r.before END
         FROM revisions r WHERE r.batch_id = ?4 ORDER BY r.id`,
      )
      .bind(actor, cs.batchId, undoSummary(summary), batchId),
  );
  // Deleted rows come back from their recorded copies, archives before their members.
  cs.push(
    db
      .prepare(
        `INSERT INTO files (${FILE_COLUMNS.join(', ')})
         SELECT ${FILE_COLUMNS.map((c) => `json_extract(before, '$.${c}')`).join(', ')}
         FROM revisions WHERE batch_id = ? AND action = 'delete' ORDER BY id`,
      )
      .bind(batchId),
  );
  // One joined update per field (the earliest recorded value wins if a batch touched a file twice).
  for (const field of ENTITIES.file.fields) {
    cs.push(
      db
        .prepare(
          `UPDATE files SET ${field} = json_extract(r.before, '$.${field}'), updated_at = ${NOW}
           FROM (SELECT entity_id, before, row_number() OVER (PARTITION BY entity_id ORDER BY id) AS rn
                 FROM revisions WHERE batch_id = ? AND action = 'update' AND json_type(before, '$.${field}') IS NOT NULL) AS r
           WHERE r.rn = 1 AND files.id = r.entity_id`,
        )
        .bind(batchId),
    );
  }
  cs.push(db.prepare("DELETE FROM files WHERE id IN (SELECT entity_id FROM revisions WHERE batch_id = ? AND action = 'create')").bind(batchId));
  markUndone(cs, db, batchId);
  await cs.commit();
  const n = await db.prepare('SELECT count(*) AS n FROM revisions WHERE batch_id = ?').bind(cs.batchId).first<{ n: number }>();
  return { ok: true, count: n?.n ?? 0, batchId: cs.batchId };
}
