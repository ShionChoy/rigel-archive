-- Catalog + file organisation schema. User accounts (Better Auth) arrive in a later migration.
-- Timestamps are ISO-8601 UTC strings.

-- 名义（时期）
CREATE TABLE eras (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  years TEXT,
  sort  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO eras (id, name, years, sort) VALUES
  ('rigel-theatre', 'Rigël Theatre', '2013–', 1),
  ('grand-thaw',    'Grand Thaw',    '约 2010–2013', 2),
  ('delta-records', 'Delta Records', '约 2004–2010', 3),
  ('dezaemon',      'DEZAEMON 投稿', '2003 前后', 4);

-- 版本栏位类型：每个作品固定 7 栏，缺档也占位
CREATE TABLE slot_types (
  id      TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_ja TEXT NOT NULL,
  name_en TEXT NOT NULL,
  sort    INTEGER NOT NULL
);

INSERT INTO slot_types (id, name_zh, name_ja, name_en, sort) VALUES
  ('cd',        '实体 CD',        '実物 CD',          'Physical CD',        1),
  ('cd_rip',    'CD 抓轨',        'CD リッピング',    'CD Rip',             2),
  ('digital',   '官方数字版/母带', '公式配信・マスター', 'Official Digital',   3),
  ('streaming', '流媒体',         'ストリーミング',    'Streaming',          4),
  ('bonus',     'DL 卡/特典',      'DL カード・特典',   'DL Card / Bonus',    5),
  ('scans',     '扫图',           'スキャン',          'Scans',              6),
  ('pv',        'PV',             'PV・MV',            'PV / MV',            7);

CREATE TABLE releases (
  id            TEXT PRIMARY KEY,               -- slug, e.g. rtcd-008
  catalog_no    TEXT UNIQUE,                    -- RTCD-008
  era_id        TEXT NOT NULL REFERENCES eras(id),
  kind          TEXT NOT NULL CHECK (kind IN ('album','single','dl_card','web','game_bgm','other')),
  series        TEXT,
  title         TEXT NOT NULL,                  -- original title as published
  title_reading TEXT,
  release_date  TEXT,                           -- YYYY, YYYY-MM or YYYY-MM-DD
  event         TEXT,
  track_count   INTEGER,
  price         TEXT,
  aliases       TEXT NOT NULL DEFAULT '[]',     -- JSON array; used to match folder / file names
  links         TEXT NOT NULL DEFAULT '{}',     -- JSON object: official, bandcamp, ...
  description   TEXT,
  note          TEXT,                           -- admin-only note
  cover_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  state         TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE release_slots (
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  slot         TEXT NOT NULL REFERENCES slot_types(id),
  status       TEXT NOT NULL CHECK (status IN
                 ('collected','partial','missing','unreleased','planned','not_applicable','unknown')),
  planned_date TEXT,
  note         TEXT,
  PRIMARY KEY (release_id, slot)
);

-- 一首曲（跨作品的同一作品意义上的曲），用来汇总各版本
CREATE TABLE songs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE tracks (
  id            TEXT PRIMARY KEY,
  release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  disc          INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  song_id       TEXT REFERENCES songs(id) ON DELETE SET NULL,
  version_label TEXT,
  duration_ms   INTEGER,
  credits       TEXT,                           -- JSON
  note          TEXT,
  UNIQUE (release_id, disc, position)
);

-- 每条记录是一个「出现位置」：同一内容在两个路径出现就是两条记录，用 dup_of 指向保留的那条。
CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  origin        TEXT NOT NULL CHECK (origin IN ('nas','upload')),
  source_path   TEXT,                           -- path inside the 合辑, '/' separated (nas only)
  dir           TEXT NOT NULL DEFAULT '',       -- parent directory of source_path, for the folder tree
  member_of     TEXT REFERENCES files(id) ON DELETE CASCADE,   -- archive that contains this file
  member_path   TEXT,
  name          TEXT NOT NULL,
  ext           TEXT NOT NULL DEFAULT '',
  size          INTEGER NOT NULL,
  mtime         TEXT,
  sha256        TEXT,                           -- NULL until the file has been hashed
  blob_key      TEXT,                           -- NULL until uploaded to storage
  kind          TEXT NOT NULL,
  format        TEXT,                           -- JSON: codec, bits, rate, width, height, encoding ...
  pcm_md5       TEXT,
  rights        TEXT NOT NULL DEFAULT 'unknown' CHECK (rights IN ('own','third_party','licensed','unknown')),
  state         TEXT NOT NULL DEFAULT 'inbox' CHECK (state IN ('inbox','classified','published','ignored')),
  release_id    TEXT REFERENCES releases(id) ON DELETE SET NULL,
  slot          TEXT REFERENCES slot_types(id),
  track_id      TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  role          TEXT,
  dup_of        TEXT REFERENCES files(id) ON DELETE SET NULL,
  suggest       TEXT,                           -- JSON from the import rules; never shown publicly
  download_name TEXT,
  note          TEXT,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (slot IS NULL OR release_id IS NOT NULL)
);

CREATE UNIQUE INDEX files_nas_path ON files (source_path, ifnull(member_path, '')) WHERE origin = 'nas';
CREATE INDEX files_state_dir ON files (state, dir);
CREATE INDEX files_release ON files (release_id, slot);
CREATE INDEX files_sha256 ON files (sha256);

CREATE TABLE translations (
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  field      TEXT NOT NULL,
  lang       TEXT NOT NULL CHECK (lang IN ('ja','zh','en')),
  value      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved')),
  PRIMARY KEY (entity, entity_id, field, lang)
);

-- 修改记录：每次保存写一行或多行，同一次操作共用 batch_id，按 batch 撤销。
CREATE TABLE revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor             TEXT NOT NULL,
  batch_id          TEXT NOT NULL,
  summary           TEXT NOT NULL,
  entity            TEXT NOT NULL,
  entity_id         TEXT NOT NULL,              -- key values joined by '/'
  action            TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  before            TEXT,                       -- JSON: changed fields (update) or whole row (delete)
  after             TEXT,                       -- JSON: changed fields (update) or whole row (create)
  reverted_by_batch TEXT
);

CREATE INDEX revisions_batch ON revisions (batch_id);
CREATE INDEX revisions_entity ON revisions (entity, entity_id);

-- 站内管理组名单（Cloudflare Access 之外的第二道检查）
CREATE TABLE admins (
  email      TEXT PRIMARY KEY,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner','admin','editor')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
