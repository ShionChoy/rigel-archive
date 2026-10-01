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

/** Every column of files (migrations 0001, 0003, 0004, 0006); a test in tools/ra compares this with the schema. */
export const FILE_COLUMNS = [
  'id', 'origin', 'source_path', 'dir', 'member_of', 'member_path', 'name', 'ext', 'size', 'mtime', 'sha256',
  'blob_key', 'kind', 'format', 'pcm_md5', 'rights', 'state', 'release_id', 'slot', 'track_id', 'role', 'dup_of',
  'suggest', 'download_name', 'note', 'uploaded_by', 'created_at', 'updated_at', 'checked_at', 'source_seen',
  'replaces', 'folder_id', 'edition_id', 'sealed', 'sealed_in', 'pub_visible', 'pub_play', 'pub_clip', 'pub_quality', 'pub_download',
] as const;

export const ENTITIES = {
  release: {
    table: 'releases',
    key: ['id'],
    fields: [
      'catalog_no', 'era_id', 'kind', 'series', 'title', 'title_reading', 'release_date', 'event',
      'track_count', 'price', 'aliases', 'links', 'description', 'note', 'cover_file_id', 'state', 'artist', 'form',
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
    fields: [
      'release_id', 'slot', 'track_id', 'role', 'rights', 'state', 'dup_of', 'download_name', 'note', 'folder_id',
      'edition_id', 'sealed', 'sealed_in', 'pub_visible', 'pub_play', 'pub_clip', 'pub_quality', 'pub_download',
    ],
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
    fields: ['release_id', 'disc', 'position', 'title', 'song_id', 'version_label', 'duration_ms', 'credits', 'note', 'external_ids'],
  },
  edition: {
    table: 'editions',
    key: ['id'],
    fields: [
      'release_id', 'slot', 'name', 'catalog_no', 'release_date', 'source', 'status', 'based_on', 'is_default',
      'track_count', 'album_title', 'cover_file_id', 'external_ids', 'note', 'sort',
      'pub_shown', 'pub_visible', 'pub_play', 'pub_clip', 'pub_quality', 'pub_download',
    ],
    touch: true,
  },
  edition_track: {
    table: 'edition_tracks',
    key: ['id'],
    fields: ['edition_id', 'disc', 'position', 'track_id', 'duration_ms', 'external_ids', 'tags', 'cover'],
  },
  folder: {
    table: 'folders',
    key: ['id'],
    fields: ['parent_id', 'type', 'era_id', 'release_id', 'edition_id', 'name', 'description', 'readme_file_id', 'color', 'sort'],
  },
  edition_type: {
    table: 'slot_types',
    key: ['id'],
    fields: ['name_zh', 'name_ja', 'name_en', 'sort', 'missing_board'],
  },
  release_form: {
    table: 'release_forms',
    key: ['id'],
    fields: ['name_zh', 'name_ja', 'name_en', 'sort'],
  },
  era: {
    table: 'eras',
    key: ['id'],
    fields: ['name', 'years', 'sort'],
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
  song: N_('乐曲'),
  admin: N_('管理组成员'),
  edition: N_('版本'),
  edition_track: N_('版本曲目'),
  folder: N_('文件夹'),
  era: N_('名义'),
  edition_type: N_('版本类型'),
  release_form: N_('作品形式'),
};

/** A files column read from a JSON row; NOT NULL columns without a value get their default (rows
 * recorded before the column existed, rows made without it). */
const FILE_DEFAULTS: Record<string, string> = { sealed: '0', rights: "'unknown'", state: "'inbox'" };
const fromJson = (source: string, defaults: Record<string, string> = FILE_DEFAULTS) => (c: string) =>
  c in defaults ? `coalesce(json_extract(${source}, '$.${c}'), ${defaults[c]})` : `json_extract(${source}, '$.${c}')`;
/** The same for the other tables whose rows are deleted and restored set-based (folders made before 0007). */
const ROW_DEFAULTS: Partial<Record<EntityName, Record<string, string>>> = {
  folder: { type: "'plain'", name: "''", sort: '0' },
  edition_type: { missing_board: '1' },
  edition_track: { tags: "'{}'" },
  // 0014: rows made or recorded without them open everything (lib/access.ts OPEN_EDITION).
  edition: { pub_shown: '1', pub_visible: '1', pub_play: "'full'", pub_clip: "'0+60'", pub_quality: "'original'", pub_download: '1' },
};
/**
 * Columns since dropped (folders.extras in 0011, edition_tracks.title in 0012): older revisions of them are
 * left out of an undo.
 */
const RETIRED: Partial<Record<EntityName, readonly string[]>> = { folder: ['extras'], edition_track: ['title'] };
/** Tables since dropped (release_slots in 0012): their old revisions are skipped when a batch is undone. */
const RETIRED_TABLES: readonly EntityName[] = ['release_slot'];
const withoutRetired = (entity: EntityName, row: Row | null): Row | null =>
  row && Object.fromEntries(Object.entries(row).filter(([f]) => !RETIRED[entity]?.includes(f)));

// Keeps each statement well under D1's 100 bound-parameter limit.
const CHUNK = 60;
// Ids per JSON parameter (D1 allows up to 2 MB per value; 2,000 ids are about 40 KB).
const ID_CHUNK = 2000;
// Rows (patches, new rows) per JSON parameter: a few hundred KB.
const ROW_CHUNK = 1000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

// What visitors can reach is decided when a page is made, and the media addresses it hands out stay good for
// a while (lib/public/media.ts). A change to something the public site may be showing counts up
// meta.media_epoch, which every public address carries, so that the addresses handed out before stop
// working at once. The checks are loose on purpose (a published work is enough): counting up too often only
// makes visitors fetch their thumbnails again.
/** Columns whose change can close what the public site shows. */
const MEDIA_FIELDS: Partial<Record<EntityName, readonly string[]>> = {
  file: ['rights', 'state', 'edition_id', 'release_id', 'dup_of', 'sealed_in', 'pub_visible', 'pub_play', 'pub_clip', 'pub_quality', 'pub_download'],
  edition: ['status', 'release_id', 'pub_shown', 'pub_visible', 'pub_play', 'pub_clip', 'pub_quality', 'pub_download'],
  release: ['state'],
};
/** SQL on `files` (unaliased): in an edition of a published work, rights set. */
export const FILE_ON_SITE = `files.rights != 'unknown' AND files.edition_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM editions ge JOIN releases gr ON gr.id = ge.release_id WHERE ge.id = files.edition_id AND gr.state = 'published')`;
const ON_SITE: Partial<Record<EntityName, string>> = {
  file: FILE_ON_SITE,
  edition: "EXISTS (SELECT 1 FROM releases gr WHERE gr.id = editions.release_id AND gr.state = 'published')",
  release: "releases.state = 'published'",
};
const BUMP_MEDIA = "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'media_epoch'";
const touchesMedia = (entity: EntityName, fields: readonly string[]) => fields.some((f) => MEDIA_FIELDS[entity]?.includes(f));

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
  private retitled = false;
  private queued = new Map<EntityName, Row[]>();

  constructor(
    private db: D1Database,
    private actor: string,
    public summary: string,
    readonly batchId: string = crypto.randomUUID(),
  ) {}

  /** Change the summary of the whole batch (e.g. once a count is known); applied when committing. */
  setSummary(text: string) {
    this.summary = text;
    this.retitled = true;
  }

  get size(): number {
    return this.statements.length + this.queued.size;
  }

  get actorName(): string {
    return this.actor;
  }

  /** Count up the media epoch when `exists` (an SQL query) finds a row, checked before what follows changes it. */
  guardMedia(exists: string, binds: unknown[]) {
    this.statements.push(this.db.prepare(`${BUMP_MEDIA} AND EXISTS (${exists})`).bind(...binds));
  }

  /** The same for one row of a table the public site may show. */
  private guardRow(entity: EntityName, key: Row) {
    const cond = ON_SITE[entity];
    if (!cond) return;
    this.guardMedia(`SELECT 1 FROM ${spec(entity).table} WHERE ${keyWhere(entity)} AND ${cond}`, keyValues(entity, key));
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
    if (touchesMedia(entity, changed)) this.guardRow(entity, key);
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
    this.guardRow(entity, key);
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
   * are skipped by both statements. The ids travel as one JSON parameter per chunk.
   */
  updateFiles(ids: string[], patch: Row) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      this.updateFilesWhere('id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids.slice(i, i + ID_CHUNK))], patch);
    }
  }

  /**
   * The same, for the files matching an SQL condition on `files` (e.g. every member of an archive,
   * found with a recursive query), so the ids never leave the database.
   */
  updateFilesWhere(where: string, binds: unknown[], patch: Row) {
    const fields = Object.keys(patch);
    checkFields('file', fields);
    if (fields.length === 0) return;
    const values = fields.map((f) => patch[f] ?? null);
    const unchanged = fields.map((f) => `${f} IS ?`).join(' AND ');
    const beforeJson = `json_object(${fields.map((f) => `'${f}', ${f}`).join(', ')})`;
    const afterJson = `json_object(${fields.map((f) => `'${f}', ?`).join(', ')})`;
    const condition = `(${where}) AND NOT (${unchanged})`;
    if (touchesMedia('file', fields)) this.guardMedia(`SELECT 1 FROM files WHERE ${condition} AND ${FILE_ON_SITE}`, [...binds, ...values]);
    this.statements.push(
      this.db
        .prepare(
          `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
           SELECT ?, ?, ?, 'file', id, 'update', ${beforeJson}, ${afterJson} FROM files WHERE ${condition}`,
        )
        .bind(this.actor, this.batchId, this.summary, ...values, ...binds, ...values),
    );
    this.countedUpdates.push(this.statements.length);
    this.statements.push(
      this.db
        .prepare(`UPDATE files SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ${NOW} WHERE ${condition}`)
        .bind(...values, ...binds, ...values),
    );
  }

  /**
   * Delete files with set-based statements, recording each whole row so the deletion can be undone.
   * `levels` lists archives before their members (level 0 = top): undo re-inserts in revision order,
   * so parents come back before the members that reference them.
   */
  deleteFiles(levels: string[][]) {
    const row = `json_object(${FILE_COLUMNS.map((c) => `'${c}', ${c}`).join(', ')})`;
    const all = levels.flat();
    for (let i = 0; i < all.length; i += ID_CHUNK) {
      this.guardMedia(`SELECT 1 FROM files WHERE id IN (SELECT value FROM json_each(?)) AND ${FILE_ON_SITE}`, [JSON.stringify(all.slice(i, i + ID_CHUNK))]);
    }
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
   * Delete the rows of a single-key table matching an SQL condition on it (alias `t`, parameters ?1 …),
   * recording each whole row so the deletion can be undone. `order` (may use the same parameters) sets
   * the order they are recorded in: children before parents.
   */
  deleteWhere(entity: EntityName, where: string, binds: unknown[], order = '') {
    const s = spec(entity);
    if (s.key.length !== 1 || entity === 'file') throw new Error(`deleteWhere: ${entity}`);
    const key = s.key[0];
    const k = binds.length;
    const row = `json_object(${rowColumns(entity).map((c) => `'${c}', t.${c}`).join(', ')})`;
    const onSite = ON_SITE[entity];
    if (onSite) this.guardMedia(`SELECT 1 FROM ${s.table} AS t WHERE ${where} AND t.${key} IN (SELECT ${key} FROM ${s.table} WHERE ${onSite})`, binds);
    this.statements.push(
      this.db
        .prepare(
          `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
           SELECT ?${k + 1}, ?${k + 2}, ?${k + 3}, ?${k + 4}, t.${key}, 'delete', ${row}, NULL
           FROM ${s.table} AS t WHERE ${where} ${order ? `ORDER BY ${order}` : ''}`,
        )
        .bind(...binds, this.actor, this.batchId, this.summary, entity),
    );
    this.countedUpdates.push(this.statements.length);
    this.statements.push(this.db.prepare(`DELETE FROM ${s.table} AS t WHERE ${where}`).bind(...binds));
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
             SELECT ${cols.map(fromJson('j.value')).join(', ')} FROM json_each(?) j ORDER BY j.key`,
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

  /**
   * Create a row with the other rows of its table made in this batch, in one set-based statement pair
   * run before everything else at commit (folders and editions made while filing thousands of files).
   */
  queueCreate(entity: EntityName, row: Row) {
    const list = this.queued.get(entity) ?? [];
    list.push(row);
    this.queued.set(entity, list);
    this.rowChanges += 1;
  }

  /** Rows of this table waiting to be created (made while filing). */
  queuedCount(entity: EntityName): number {
    return this.queued.get(entity)?.length ?? 0;
  }

  private queuedStatements(): D1PreparedStatement[] {
    const out: D1PreparedStatement[] = [];
    // Parents first: a folder names its era, release or edition, all of which may be made in this batch.
    const order: EntityName[] = ['era', 'release', 'edition', 'folder'];
    const rank = (e: EntityName) => (order.includes(e) ? order.indexOf(e) : order.length);
    for (const [entity, rows] of [...this.queued].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const s = spec(entity);
      const cols = rowColumns(entity);
      for (let i = 0; i < rows.length; i += ROW_CHUNK) {
        const chunk = JSON.stringify(rows.slice(i, i + ROW_CHUNK).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
        out.push(
          this.db
            .prepare(`INSERT INTO ${s.table} (${cols.join(', ')}) SELECT ${cols.map(fromJson('j.value', ROW_DEFAULTS[entity] ?? {})).join(', ')} FROM json_each(?) j ORDER BY j.key`)
            .bind(chunk),
          this.db
            .prepare(
              `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
               SELECT ?, ?, ?, ?, ${s.key.map((k) => `json_extract(j.value, '$.${k}')`).join(" || '/' || ")}, 'create', NULL, j.value
               FROM json_each(?) j ORDER BY j.key`,
            )
            .bind(this.actor, this.batchId, this.summary, entity, chunk),
        );
      }
    }
    return out;
  }

  /**
   * Give many files each their own patch, with two set-based statements per 1,000 files and set of
   * fields: the patches travel as one JSON parameter. Files already matching their patch are skipped.
   */
  patchFiles(entries: Iterable<[string, Row]>) {
    const bySignature = new Map<string, { fields: string[]; rows: Row[] }>();
    for (const [id, patch] of entries) {
      const fields = Object.keys(patch).sort();
      if (fields.length === 0) continue;
      checkFields('file', fields);
      const key = fields.join(',');
      const group = bySignature.get(key) ?? { fields, rows: [] };
      group.rows.push({ ...patch, id });
      bySignature.set(key, group);
    }
    for (const { fields, rows } of bySignature.values()) {
      const value = (f: string) => `json_extract(j.value, '$.${f}')`;
      const unchanged = fields.map((f) => `f.${f} IS ${value(f)}`).join(' AND ');
      const unchangedHere = fields.map((f) => `files.${f} IS ${value(f)}`).join(' AND ');
      const beforeJson = `json_object(${fields.map((f) => `'${f}', f.${f}`).join(', ')})`;
      const afterJson = `json_object(${fields.map((f) => `'${f}', ${value(f)}`).join(', ')})`;
      for (let i = 0; i < rows.length; i += ROW_CHUNK) {
        const chunk = JSON.stringify(rows.slice(i, i + ROW_CHUNK));
        if (touchesMedia('file', fields)) {
          this.guardMedia(`SELECT 1 FROM json_each(?) j JOIN files ON files.id = json_extract(j.value, '$.id') WHERE NOT (${unchangedHere}) AND ${FILE_ON_SITE}`, [chunk]);
        }
        this.statements.push(
          this.db
            .prepare(
              `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
               SELECT ?, ?, ?, 'file', f.id, 'update', ${beforeJson}, ${afterJson}
               FROM json_each(?) j JOIN files f ON f.id = json_extract(j.value, '$.id') WHERE NOT (${unchanged})`,
            )
            .bind(this.actor, this.batchId, this.summary, chunk),
        );
        this.countedUpdates.push(this.statements.length);
        this.statements.push(
          this.db
            .prepare(
              `UPDATE files SET ${fields.map((f) => `${f} = ${value(f)}`).join(', ')}, updated_at = ${NOW}
               FROM json_each(?) j WHERE files.id = json_extract(j.value, '$.id') AND NOT (${unchangedHere})`,
            )
            .bind(chunk),
        );
      }
    }
  }

  push(...statements: D1PreparedStatement[]) {
    this.statements.push(...statements);
  }

  /** Runs everything in one D1 batch. Returns the number of rows changed. */
  async commit(): Promise<number> {
    const created = this.queuedStatements();
    this.statements = [...created, ...this.statements];
    this.countedUpdates = this.countedUpdates.map((i) => i + created.length);
    this.queued.clear();
    if (this.statements.length === 0) return 0;
    if (this.retitled) this.statements.push(this.db.prepare('UPDATE revisions SET summary = ? WHERE batch_id = ?').bind(this.summary, this.batchId));
    // The public site's cached pages are kept per catalogue version (lib/public/cache.ts): any change starts a new one.
    this.statements.push(this.db.prepare(
      "INSERT INTO meta (key, value) VALUES ('public_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
    ));
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
 *
 * File changes are undone with a fixed number of set-based statements however many files they touched;
 * the other rows of the batch (a folder or edition made for a move, a track list) one by one, up to 300.
 */
export async function undoBatch(db: D1Database, actor: string, batchId: string, media?: R2Bucket): Promise<UndoResult> {
  const info = await db
    .prepare(
      `SELECT count(*) AS n, sum(entity = 'file') AS files, max(reverted_by_batch) AS reverted,
              (SELECT summary FROM revisions WHERE batch_id = ?1 ORDER BY id LIMIT 1) AS summary
       FROM revisions WHERE batch_id = ?1`,
    )
    .bind(batchId)
    .first<{ n: number; files: number | null; reverted: string | null; summary: string | null }>();
  if (!info || info.n === 0) return { ok: false, reason: new UserError('找不到这次修改') };
  if (info.reverted) return { ok: false, reason: new UserError('这次修改已经撤销过') };
  // Rows of single-key tables made or deleted in this batch (folders, editions … made while filing, a
  // folder deleted with everything below it) are undone set-based; updates and other tables one by one.
  const bulk = BULK_ORDER;
  const bulkList = bulk.map((e) => `'${e}'`).join(', ');
  const { results: revs } = await db
    .prepare(
      `SELECT id, summary, entity, entity_id, action, before, after, reverted_by_batch FROM revisions
       WHERE batch_id = ? AND entity != 'file' AND NOT (action IN ('create', 'delete') AND entity IN (${bulkList})) ORDER BY id DESC LIMIT 301`,
    )
    .bind(batchId)
    .all<RevisionRow>();
  if (revs.length > 300) return { ok: false, reason: new UserError('这次修改太大（超过 {n} 处），不能自动撤销', { n: 300 }) };

  const cs = new ChangeSet(db, actor, undoSummary(info.summary ?? ''));
  // Rows made in this batch may be deleted before or after the files pointing at them are restored.
  cs.push(db.prepare('PRAGMA defer_foreign_keys = on'));
  if (info.files) {
    const refused = await undoFiles(db, cs, batchId, media);
    if (refused) return { ok: false, reason: refused };
  }
  const refused = (await undoCreated(db, cs, batchId, bulk)) ?? (await undoDeleted(db, cs, batchId, bulk));
  if (refused) return { ok: false, reason: refused };
  for (const rev of revs) {
    if (!isEntity(rev.entity)) return { ok: false, reason: new UserError('未知的记录类型 {entity}', { entity: rev.entity }) };
    const entity = rev.entity;
    if (RETIRED_TABLES.includes(entity)) continue;
    const key = parseEntityId(entity, rev.entity_id);
    const before = withoutRetired(entity, rev.before ? (JSON.parse(rev.before) as Row) : null);
    const after = withoutRetired(entity, rev.after ? (JSON.parse(rev.after) as Row) : null);

    if (rev.action === 'update' && before && after) {
      if (Object.keys(after).length === 0) continue;
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
  await cs.commit();
  const n = await db.prepare('SELECT count(*) AS n FROM revisions WHERE batch_id = ?').bind(cs.batchId).first<{ n: number }>();
  return { ok: true, count: n?.n ?? 0, batchId: cs.batchId };
}

function markUndone(cs: ChangeSet, db: D1Database, batchId: string) {
  cs.push(db.prepare('UPDATE revisions SET reverted_by_batch = ? WHERE batch_id = ?').bind(cs.batchId, batchId));
  // Undoing an undo re-applies the original change, so the original is no longer marked as undone.
  cs.push(db.prepare('UPDATE revisions SET reverted_by_batch = NULL WHERE reverted_by_batch = ?').bind(batchId));
}

/**
 * Single-key tables whose made or deleted rows an undo handles set-based, children before parents (the
 * order rows made in a batch are deleted in; a deletion is restored in the reverse order).
 */
const BULK_ORDER: EntityName[] = (() => {
  const first: EntityName[] = ['edition_track', 'track', 'folder', 'edition', 'release', 'era', 'song'];
  const rest = (Object.keys(ENTITIES) as EntityName[]).filter((e) => e !== 'file' && spec(e).key.length === 1 && !first.includes(e));
  return [...first, ...rest];
})();

/**
 * Add the statements that restore the rows of single-key tables this batch deleted, parents first.
 * Refuses when one of them has been made again since.
 */
async function undoDeleted(db: D1Database, cs: ChangeSet, batchId: string, entities: EntityName[]): Promise<UserError | null> {
  const { results } = await db
    .prepare(
      `SELECT entity, count(*) AS n FROM revisions
       WHERE batch_id = ? AND action = 'delete' AND entity IN (${entities.map((e) => `'${e}'`).join(', ')}) GROUP BY entity`,
    )
    .bind(batchId)
    .all<{ entity: EntityName; n: number }>();
  if (results.length === 0) return null;
  for (const { entity } of results) {
    const s = spec(entity);
    const again = await db
      .prepare(
        `SELECT r.entity_id FROM revisions r JOIN ${s.table} t ON t.${s.key[0]} = r.entity_id
         WHERE r.batch_id = ? AND r.entity = ? AND r.action = 'delete' LIMIT 1`,
      )
      .bind(batchId, entity)
      .first<{ entity_id: string }>();
    if (again) return new UserError('{entity} {id} 已被重新创建', { entity: ENTITY_LABELS[entity], id: again.entity_id });
  }
  for (const entity of [...entities].reverse()) {
    if (!results.some((r) => r.entity === entity)) continue;
    const s = spec(entity);
    const cols = rowColumns(entity);
    cs.push(
      db
        .prepare(
          `INSERT INTO ${s.table} (${cols.join(', ')})
           SELECT ${cols.map(fromJson('before', ROW_DEFAULTS[entity] ?? {})).join(', ')}
           FROM revisions WHERE batch_id = ? AND entity = ? AND action = 'delete' ORDER BY id DESC`,
        )
        .bind(batchId, entity),
      db
        .prepare(
          `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
           SELECT ?1, ?2, ?3, entity, entity_id, 'create', NULL, before
           FROM revisions WHERE batch_id = ?4 AND entity = ?5 AND action = 'delete' ORDER BY id DESC`,
        )
        .bind(cs.actorName, cs.batchId, cs.summary, batchId, entity),
    );
  }
  return null;
}

/** The value of files.<field> for a field named in a json_each row `j` (editable fields only). */
const FILE_FIELD = `CASE j.key ${ENTITIES.file.fields.map((f) => `WHEN '${f}' THEN f.${f}`).join(' ')} END`;
const FILE_EDITABLE = ENTITIES.file.fields.map((f) => `'${f}'`).join(', ');

/**
 * Add the statements that delete the rows of single-key tables this batch made. Refuses when files or
 * folders added later still use a folder or edition made in the batch.
 */
async function undoCreated(db: D1Database, cs: ChangeSet, batchId: string, entities: EntityName[]): Promise<UserError | null> {
  const made = (entity: string) => `(SELECT entity_id FROM revisions WHERE batch_id = ?1 AND entity = '${entity}' AND action = 'create')`;
  // Rows this batch changed are put back by the same undo; anything else that now points into a row it
  // made (a file, folder, edition or release added later) would be lost with it, so the undo refuses.
  const touched = (entity: string) => `(SELECT entity_id FROM revisions WHERE batch_id = ?1 AND entity = '${entity}')`;
  const later = await db
    .prepare(
      `SELECT (SELECT count(*) FROM files WHERE (folder_id IN ${made('folder')} OR edition_id IN ${made('edition')} OR release_id IN ${made('release')})
                 AND id NOT IN ${touched('file')}) AS files,
              (SELECT count(*) FROM folders WHERE (parent_id IN ${made('folder')} OR edition_id IN ${made('edition')}
                   OR release_id IN ${made('release')} OR era_id IN ${made('era')})
                 AND id NOT IN ${touched('folder')}) AS folders,
              (SELECT count(*) FROM editions WHERE (release_id IN ${made('release')} OR slot IN ${made('edition_type')})
                 AND id NOT IN ${touched('edition')}) AS editions,
              (SELECT count(*) FROM releases WHERE (era_id IN ${made('era')} OR form IN ${made('release_form')})
                 AND id NOT IN ${touched('release')}) AS releases,
              (SELECT count(*) FROM (SELECT entity_id FROM revisions WHERE batch_id = ?1 AND action = 'create' AND entity IN (${entities.map((e) => `'${e}'`).join(', ')}))) AS n`,
    )
    .bind(batchId)
    .first<{ files: number; folders: number; editions: number; releases: number; n: number }>();
  if (later?.files || later?.folders || later?.editions || later?.releases) return new UserError('这次新建的文件夹、作品、版本、类型或形式后来又被用到了，不能自动撤销');
  if (!later?.n) return null;
  for (const entity of entities) {
    const s = spec(entity);
    const key = s.key[0];
    const cols = rowColumns(entity);
    cs.push(
      db
        .prepare(
          `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
           SELECT ?1, ?2, ?3, '${entity}', t.${key}, 'delete', json_object(${cols.map((c) => `'${c}', t.${c}`).join(', ')}), NULL
           FROM ${s.table} t WHERE t.${key} IN (SELECT entity_id FROM revisions WHERE batch_id = ?4 AND entity = '${entity}' AND action = 'create')`,
        )
        .bind(cs.actorName, cs.batchId, cs.summary, batchId),
      db.prepare(`DELETE FROM ${s.table} WHERE ${key} IN (SELECT entity_id FROM revisions WHERE batch_id = ? AND entity = '${entity}' AND action = 'create')`).bind(batchId),
    );
  }
  return null;
}

/**
 * Add the statements that undo the file changes of a batch to `cs` (an upload session, a bulk accept
 * over a whole archive, a deletion with its members, a move): a fixed number of set-based statements
 * however many files it touched. Returns why it cannot be undone, if so.
 */
async function undoFiles(db: D1Database, cs: ChangeSet, batchId: string, media?: R2Bucket): Promise<UserError | null> {
  const conflict = await db
    .prepare(
      `SELECT r.entity_id, r.action FROM revisions r LEFT JOIN files f ON f.id = r.entity_id
       WHERE r.batch_id = ?1 AND r.entity = 'file' AND (
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
    return new UserError(text, { id: conflict.entity_id });
  }

  if (media) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT json_extract(before, '$.blob_key') AS key FROM revisions
         WHERE batch_id = ? AND entity = 'file' AND action = 'delete' AND json_extract(before, '$.blob_key') IS NOT NULL`,
      )
      .bind(batchId)
      .all<{ key: string }>();
    for (const { key } of results) {
      if (!(await media.head(key))) return new UserError('存储里的文件 {key} 已被清理，不能恢复', { key });
    }
  }

  const row = `json_object(${FILE_COLUMNS.map((c) => `'${c}', f.${c}`).join(', ')})`;
  cs.guardMedia(`SELECT 1 FROM files WHERE id IN (SELECT entity_id FROM revisions WHERE batch_id = ? AND entity = 'file') AND ${FILE_ON_SITE}`, [batchId]);
  // The inverse revisions, in the original order so a later undo of this undo restores parents first.
  cs.push(
    db
      .prepare(
        `INSERT INTO revisions (actor, batch_id, summary, entity, entity_id, action, before, after)
         SELECT ?1, ?2, ?3, 'file', r.entity_id,
                CASE r.action WHEN 'create' THEN 'delete' WHEN 'delete' THEN 'create' ELSE 'update' END,
                CASE r.action WHEN 'create' THEN (SELECT ${row} FROM files f WHERE f.id = r.entity_id) WHEN 'delete' THEN NULL ELSE r.after END,
                CASE r.action WHEN 'create' THEN NULL ELSE r.before END
         FROM revisions r WHERE r.batch_id = ?4 AND r.entity = 'file' ORDER BY r.id`,
      )
      .bind(cs.actorName, cs.batchId, cs.summary, batchId),
  );
  // Deleted rows come back from their recorded copies, archives before their members.
  cs.push(
    db
      .prepare(
        `INSERT INTO files (${FILE_COLUMNS.join(', ')})
         SELECT ${FILE_COLUMNS.map(fromJson('before')).join(', ')}
         FROM revisions WHERE batch_id = ? AND entity = 'file' AND action = 'delete' ORDER BY id`,
      )
      .bind(batchId),
  );
  // Every field back to its value before the batch, in one statement so that constraints spanning two
  // fields (a slot needs a release) hold. When a batch touched a file twice, the earliest recorded value
  // of each field wins.
  const restore = ENTITIES.file.fields
    .map((f) => `${f} = CASE WHEN json_type(m.before, '$.${f}') IS NOT NULL THEN json_extract(m.before, '$.${f}') ELSE files.${f} END`)
    .join(', ');
  cs.push(
    db
      .prepare(
        `WITH fields AS (
           SELECT r.entity_id, j.key, j.value, row_number() OVER (PARTITION BY r.entity_id, j.key ORDER BY r.id) AS rn
           FROM revisions r, json_each(r.before) j
           WHERE r.batch_id = ? AND r.entity = 'file' AND r.action = 'update'),
         merged AS (SELECT entity_id, json_group_object(key, value) AS before FROM fields WHERE rn = 1 GROUP BY entity_id)
         UPDATE files SET ${restore}, updated_at = ${NOW} FROM merged m WHERE files.id = m.entity_id`,
      )
      .bind(batchId),
  );
  cs.push(db.prepare("DELETE FROM files WHERE id IN (SELECT entity_id FROM revisions WHERE batch_id = ? AND entity = 'file' AND action = 'create')").bind(batchId));
  return null;
}

/**
 * The batch this admin wrote since `since` (an ISO time taken when the request began), for the 「撤销」
 * button next to a page's message; null when the request changed nothing.
 */
export async function batchSince(db: D1Database, actor: string, since: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT batch_id FROM revisions WHERE actor = ? AND at >= ? ORDER BY id DESC LIMIT 1')
    // A little slack: the database's clock is not the Worker's.
    .bind(actor, new Date(Date.parse(since) - 3000).toISOString())
    .first<{ batch_id: string }>();
  return row?.batch_id ?? null;
}
