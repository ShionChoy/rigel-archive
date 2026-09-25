-- Processing in the cloud (derived files for playing and previewing, acoustic fingerprints), the
-- encrypted backup, and each admin's interface language.

-- One row per content and task, kept by the processing program (the container, or `uv run ra worker`):
-- a task is claimed before it starts (state 'running', attempts + 1), so a run that crashes still counts
-- as an attempt and a content that keeps failing stops being retried after three.
--   check        uploads: verify the SHA-256, read the specs, unpack archives (done = files.checked_at)
--   derive       files for playing and previewing (table derived)
--   fingerprint  Chromaprint fingerprint (table fingerprints) and matches (table acoustic_matches)
CREATE TABLE media_tasks (
  sha256     TEXT NOT NULL,
  task       TEXT NOT NULL CHECK (task IN ('check','derive','fingerprint')),
  version    INTEGER NOT NULL DEFAULT 0,        -- of the program's rules; a newer version redoes the task
  state      TEXT NOT NULL CHECK (state IN ('running','done','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (sha256, task)
);
CREATE INDEX media_tasks_state ON media_tasks (task, state, updated_at);

-- Files made from an original (推流版、缩略图、站内视频、波形). They can always be made again, so they
-- are not backed up. Keyed by the original's content; `key` may be shared: contents with the same
-- decoded audio stream one copy, and a FLAC that is fine as it is streams from blobs/ itself.
--   stream   FLAC for lossless streaming        aac     AAC 256 kbps (.m4a)
--   wave     waveform peaks (JSON)              img240 / img640 / img1600   WebP previews
--   video    H.264 + AAC MP4 for the site      poster  a frame of the video (WebP)
CREATE TABLE derived (
  sha256     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  size       INTEGER NOT NULL,
  info       TEXT,                              -- JSON: codec, bits, rate, kbps, width, height …
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (sha256, kind)
);
CREATE INDEX derived_key ON derived (key);

-- Chromaprint fingerprints of whole audio files (base64 of the raw little-endian uint32 values).
CREATE TABLE fingerprints (
  sha256     TEXT PRIMARY KEY,
  duration   REAL NOT NULL,
  fp         TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Pairs of contents that sound like the same recording (a < b): a different encoding, master or edit,
-- or one track inside a longer file (a whole-album rip, a compilation).
CREATE TABLE acoustic_matches (
  a          TEXT NOT NULL,
  b          TEXT NOT NULL,
  score      REAL NOT NULL,     -- share of fingerprint bits that agree where they match: 0.5 chance, 1 identical
  offset_ms  INTEGER NOT NULL,  -- where the matching part starts in b minus where it starts in a
  matched_ms INTEGER NOT NULL,  -- how long the matching part is
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX acoustic_matches_b ON acoustic_matches (b);

-- Runs of the encrypted backup to Backblaze B2 (originals + a daily database export).
CREATE TABLE backup_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at TEXT,
  ok          INTEGER,                          -- NULL while running, then 1 or 0
  report      TEXT                              -- JSON: counts, bytes, the database export, errors
);

-- Interface language of the admin (NULL: from the browser's language).
ALTER TABLE admins ADD COLUMN lang TEXT CHECK (lang IN ('zh','ja'));
