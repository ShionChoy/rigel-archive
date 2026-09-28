-- 整理台改版: one folder tree. Every era (名义), release (作品) and edition (版本) is a folder of that type;
-- the admins' own folders are «plain». A typed folder names its entity (era_id / release_id / edition_id)
-- and nothing else: which release or edition a plain folder belongs to follows from the folders above it.
-- Files keep release_id / edition_id / slot (read everywhere else) and now always point at their folder.
PRAGMA defer_foreign_keys = true;

CREATE TABLE folders_new (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT REFERENCES folders_new(id), -- becomes «folders» with the rename below
  type           TEXT NOT NULL DEFAULT 'plain' CHECK (type IN ('plain', 'era', 'release', 'edition')),
  era_id         TEXT REFERENCES eras(id),
  release_id     TEXT REFERENCES releases(id),
  edition_id     TEXT REFERENCES editions(id),
  name           TEXT NOT NULL DEFAULT '',     -- plain folders; a typed folder shows its entity's name
  description    TEXT,
  readme_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  color          TEXT CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink')),
  sort           INTEGER NOT NULL DEFAULT 0,   -- 0 everywhere = natural order (releases by date, editions by slot)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (type != 'plain' OR (era_id IS NULL AND release_id IS NULL AND edition_id IS NULL)),
  CHECK (type != 'era' OR (era_id IS NOT NULL AND release_id IS NULL AND edition_id IS NULL AND parent_id IS NULL)),
  CHECK (type != 'release' OR (release_id IS NOT NULL AND era_id IS NULL AND edition_id IS NULL AND parent_id IS NOT NULL)),
  CHECK (type != 'edition' OR (edition_id IS NOT NULL AND era_id IS NULL AND release_id IS NULL AND parent_id IS NOT NULL))
);

INSERT INTO folders_new (id, type, era_id, sort)
SELECT 'fd_' || lower(hex(randomblob(8))), 'era', id, 0 FROM eras;

INSERT INTO folders_new (id, parent_id, type, release_id)
SELECT 'fd_' || lower(hex(randomblob(8))), (SELECT f.id FROM folders_new f WHERE f.type = 'era' AND f.era_id = r.era_id), 'release', r.id
FROM releases r;

INSERT INTO folders_new (id, parent_id, type, edition_id)
SELECT 'fd_' || lower(hex(randomblob(8))), (SELECT f.id FROM folders_new f WHERE f.type = 'release' AND f.release_id = e.release_id), 'edition', e.id
FROM editions e;

-- The admins' folders keep their ids. One that hung directly under an era, release or edition now hangs
-- under that folder; one at the top stays at the top.
INSERT INTO folders_new (id, parent_id, type, name, description, readme_file_id, sort, created_at)
SELECT o.id,
       CASE
         WHEN o.parent_id IS NOT NULL THEN o.parent_id
         WHEN o.edition_id IS NOT NULL THEN (SELECT f.id FROM folders_new f WHERE f.type = 'edition' AND f.edition_id = o.edition_id)
         WHEN o.release_id IS NOT NULL THEN (SELECT f.id FROM folders_new f WHERE f.type = 'release' AND f.release_id = o.release_id)
         WHEN o.era_id IS NOT NULL THEN (SELECT f.id FROM folders_new f WHERE f.type = 'era' AND f.era_id = o.era_id)
       END,
       'plain', o.name, o.description, o.readme_file_id, o.sort, o.created_at
FROM folders o;

-- Dropping the old table sets files.folder_id to NULL (its ON DELETE action): keep the values aside.
CREATE TABLE files_folder_0007 AS SELECT id, folder_id FROM files WHERE folder_id IS NOT NULL;
DROP TABLE folders;
ALTER TABLE folders_new RENAME TO folders;
UPDATE files SET folder_id = (SELECT k.folder_id FROM files_folder_0007 k WHERE k.id = files.id)
WHERE id IN (SELECT id FROM files_folder_0007);
DROP TABLE files_folder_0007;

CREATE INDEX folders_parent ON folders (parent_id, sort);
CREATE UNIQUE INDEX folders_era_of ON folders (era_id) WHERE era_id IS NOT NULL;
CREATE UNIQUE INDEX folders_release_of ON folders (release_id) WHERE release_id IS NOT NULL;
CREATE UNIQUE INDEX folders_edition_of ON folders (edition_id) WHERE edition_id IS NOT NULL;

-- Files filed directly under an edition or a release now point at its folder.
UPDATE files SET folder_id = (SELECT f.id FROM folders f WHERE f.edition_id = files.edition_id)
WHERE folder_id IS NULL AND edition_id IS NOT NULL;
UPDATE files SET folder_id = (SELECT f.id FROM folders f WHERE f.release_id = files.release_id)
WHERE folder_id IS NULL AND release_id IS NOT NULL;

-- Folders pinned to an admin's 快速访问 (a personal shortcut, not in the revision log).
CREATE TABLE quick_access (
  admin     TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  sort      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (admin, folder_id)
);

-- 智能文件夹: saved conditions, shared by the whole team. `rules` = {"match": "all"|"any", "rules": [...]}.
CREATE TABLE smart_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rules      TEXT NOT NULL,
  color      TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- The old personal saved filters are replaced by smart folders (none were saved in production).
DROP TABLE saved_views;
