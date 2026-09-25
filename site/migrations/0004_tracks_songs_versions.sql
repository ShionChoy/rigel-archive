-- Track list editing, song merging and file versions.

-- Track positions are renumbered when rows are dragged into a new order; a UNIQUE (release, disc,
-- position) constraint would reject the intermediate states of such a batch (and of its undo), so the
-- table is rebuilt without it. The order is kept by the editor instead. The table is still empty.
PRAGMA defer_foreign_keys = true;
CREATE TABLE tracks_new (
  id            TEXT PRIMARY KEY,
  release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  disc          INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  song_id       TEXT REFERENCES songs(id) ON DELETE SET NULL,
  version_label TEXT,
  duration_ms   INTEGER,
  credits       TEXT,
  note          TEXT
);
INSERT INTO tracks_new SELECT id, release_id, disc, position, title, song_id, version_label, duration_ms, credits, note FROM tracks;
DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;
CREATE INDEX tracks_release ON tracks (release_id, disc, position);
CREATE INDEX tracks_song ON tracks (song_id);

-- A new version of a file (a better scan, a corrected master) points at the version it replaces; the
-- old one stays, with its classification, and is shown as an older version.
ALTER TABLE files ADD COLUMN replaces TEXT REFERENCES files(id) ON DELETE SET NULL;
CREATE INDEX files_replaces ON files (replaces) WHERE replaces IS NOT NULL;
CREATE INDEX files_track ON files (track_id) WHERE track_id IS NOT NULL;
CREATE INDEX files_dup_of ON files (dup_of) WHERE dup_of IS NOT NULL;
