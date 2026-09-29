-- Editions no longer come with an attachments folder (附件, migration 0008): whether an edition has
-- folders, and which, is the organizers' choice. The built-in ones become ordinary folders; those nobody
-- used (still named 附件, empty, without a note, colour or readme) go. Their creation stays in the
-- revision log: undoing it later finds nothing to delete, which is fine.
DELETE FROM folders
WHERE extras = 1 AND name = '附件' AND description IS NULL AND color IS NULL AND readme_file_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM files x WHERE x.folder_id = folders.id)
  AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = folders.id);

-- The mark itself goes. (Dropping a column rewrites the rows in place; unlike DROP TABLE it deletes
-- nothing, so no ON DELETE action fires.)
DROP INDEX folders_extras;
ALTER TABLE folders DROP COLUMN extras;
