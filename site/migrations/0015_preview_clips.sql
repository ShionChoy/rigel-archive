-- Preview clips (2026-09-30; 设计文档「文件权限方案 · 试听片段」): a track set to 「仅试听」 plays only a part of
-- it, cut by the processing program with a short fade (tools/ra derive.py clip), as FLAC (lossless) and AAC
-- (lossy), stored under derived/clip/. One row per content, part and version; a content may have several
-- parts when files of it in different editions want different ones. Parts no file wants any more are
-- deleted when the next ones are stored (src/lib/clips.ts).

CREATE TABLE clips (
  sha256     TEXT NOT NULL,      -- the content it was cut from
  from_ms    INTEGER NOT NULL,   -- where it starts in the track
  to_ms      INTEGER NOT NULL,   -- where it ends
  kind       TEXT NOT NULL CHECK (kind IN ('lossless', 'lossy')),
  key        TEXT NOT NULL,      -- storage key
  size       INTEGER NOT NULL,
  info       TEXT,               -- JSON: codec, bits, rate, kbps
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (sha256, from_ms, to_ms, kind)
);

-- The processing queue learns the task «clip». media_tasks is rebuilt for its CHECK (no table points at it);
-- `spec` keeps which parts a clip task was asked for, so a content that failed three times is tried again
-- once the parts wanted change.
CREATE TABLE media_tasks_new (
  sha256     TEXT NOT NULL,
  task       TEXT NOT NULL CHECK (task IN ('check','derive','fingerprint','clip')),
  version    INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL CHECK (state IN ('running','done','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  spec       TEXT,
  PRIMARY KEY (sha256, task)
);
INSERT INTO media_tasks_new (sha256, task, version, state, attempts, error, started_at, updated_at)
  SELECT sha256, task, version, state, attempts, error, started_at, updated_at FROM media_tasks;
DROP TABLE media_tasks;
ALTER TABLE media_tasks_new RENAME TO media_tasks;
CREATE INDEX media_tasks_state ON media_tasks (task, state, updated_at);
