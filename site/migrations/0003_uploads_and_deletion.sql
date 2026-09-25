-- Admin uploads, the ra worker queue, and deletion of files whose original is gone.

-- Uploads: when `ra worker` verified the SHA-256 and read the specs (NULL = still queued).
ALTER TABLE files ADD COLUMN checked_at TEXT;
-- 合辑 files: the import run that last saw the original. Rows older than meta.nas_seen have lost
-- their original (moved, renamed or deleted in source/) and may be deleted.
ALTER TABLE files ADD COLUMN source_seen TEXT;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX files_origin ON files (origin, state);
CREATE INDEX files_member_of ON files (member_of) WHERE member_of IS NOT NULL;
CREATE INDEX files_upload_queue ON files (sha256) WHERE origin = 'upload' AND checked_at IS NULL;
