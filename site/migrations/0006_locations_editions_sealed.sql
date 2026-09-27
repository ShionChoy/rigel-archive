-- 整理台升级: where each file sits in the archive (folders), editions of a release with their own track
-- order, archives kept whole (sealed), and saved 整理台 views.

-- One concrete release of a work (初版 CD, 再版, Bandcamp, Amazon …) or one source of it. `slot` is
-- which of the 7 placeholder slots it fills; files filed under the edition get that slot.
CREATE TABLE editions (
  id            TEXT PRIMARY KEY,
  release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL REFERENCES slot_types(id),
  name          TEXT NOT NULL,
  catalog_no    TEXT,
  release_date  TEXT,
  source        TEXT,
  status        TEXT NOT NULL DEFAULT 'collected' CHECK (status IN ('collected','partial','missing','planned','unknown')),
  based_on      TEXT REFERENCES editions(id) ON DELETE SET NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  track_count   INTEGER,                        -- as published (may differ from the files at hand)
  album_title   TEXT,                           -- ALBUM tag when it differs from the release title (「… (2nd Edition)」)
  cover_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  external_ids  TEXT NOT NULL DEFAULT '{}',     -- JSON: musicbrainz_release, musicbrainz_release_group, bandcamp …
  note          TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX editions_release ON editions (release_id, slot, sort);

-- An edition's track order: its disc/position N is this track of the release (the release's tracks are
-- every track any edition has). `title` is the edition's own title for it, when it differs.
CREATE TABLE edition_tracks (
  id           TEXT PRIMARY KEY,
  edition_id   TEXT NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  disc         INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL,
  track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  title        TEXT,
  duration_ms  INTEGER,
  external_ids TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX edition_tracks_edition ON edition_tracks (edition_id, disc, position);
CREATE INDEX edition_tracks_track ON edition_tracks (track_id);

-- Folders the admins make. A folder hangs under another folder, or directly under one of the nodes the
-- system shows by itself (an era, a release, an edition), or at the top. Every folder carries the era,
-- release and edition it sits under (copied down from its parent), so filing a file in it fills the
-- file's release_id and edition_id from the folder without walking the tree.
CREATE TABLE folders (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT REFERENCES folders(id),
  era_id         TEXT REFERENCES eras(id),
  release_id     TEXT REFERENCES releases(id) ON DELETE CASCADE,
  edition_id     TEXT REFERENCES editions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  readme_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX folders_parent ON folders (parent_id);
CREATE INDEX folders_release ON folders (release_id) WHERE release_id IS NOT NULL;

ALTER TABLE tracks ADD COLUMN external_ids TEXT NOT NULL DEFAULT '{}';
-- Album artist (and label) written into downloads; empty = the era's name.
ALTER TABLE releases ADD COLUMN artist TEXT;

-- Where a file sits: a folder (which brings its release and edition), else an edition, else a release.
ALTER TABLE files ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL;
-- An archive kept whole: its contents are not organized one by one. Every file inside it (at any depth)
-- points to it with sealed_in and is left out of the 整理台, the counts and the processing queue.
ALTER TABLE files ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN sealed_in TEXT REFERENCES files(id) ON DELETE SET NULL;
CREATE INDEX files_folder ON files (folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX files_edition ON files (edition_id) WHERE edition_id IS NOT NULL;
CREATE INDEX files_sealed_in ON files (sealed_in) WHERE sealed_in IS NOT NULL;
CREATE INDEX files_dir ON files (dir);

-- Filters an admin saved on the 整理台 (their own; not part of the revision log).
CREATE TABLE saved_views (
  id         TEXT PRIMARY KEY,
  admin      TEXT NOT NULL,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX saved_views_admin ON saved_views (admin, sort);

-- Files already filed under a slot get an edition of that slot (named after it), and «classified» now
-- means «has a place»: files classified without one go back to the inbox. (Nothing was filed yet when
-- this was written; this keeps local test databases consistent.)
INSERT INTO editions (id, release_id, slot, name)
SELECT 'e_' || lower(hex(randomblob(8))), p.release_id, p.slot, st.name_zh
FROM (SELECT DISTINCT release_id, slot FROM files WHERE release_id IS NOT NULL AND slot IS NOT NULL) p
JOIN slot_types st ON st.id = p.slot;
UPDATE files SET edition_id = (SELECT e.id FROM editions e WHERE e.release_id = files.release_id AND e.slot = files.slot)
WHERE release_id IS NOT NULL AND slot IS NOT NULL;
UPDATE files SET state = 'inbox' WHERE state = 'classified' AND release_id IS NULL;
-- Existing track lists become the track order of the edition holding most of their files.
INSERT INTO edition_tracks (id, edition_id, disc, position, track_id)
SELECT 'et_' || lower(hex(randomblob(8))), best.edition_id, t.disc, t.position, t.id
FROM tracks t
JOIN (
  SELECT release_id, edition_id FROM (
    SELECT f.release_id, f.edition_id, count(*) AS n,
           row_number() OVER (PARTITION BY f.release_id ORDER BY count(*) DESC) AS rn
    FROM files f JOIN tracks t2 ON t2.id = f.track_id
    WHERE f.edition_id IS NOT NULL GROUP BY f.release_id, f.edition_id
  ) WHERE rn = 1
) best ON best.release_id = t.release_id;
