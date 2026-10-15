-- Folders no longer take a colour (2026-10-15: nobody used it, and it was one more thing for new organizers
-- to wonder about). Production had none set, on folders or on smart folders (whose colour was never offered).
-- Older revisions that mention folders.color are left out of an undo (lib/changes.ts RETIRED). Dropping a
-- column rewrites the rows in place; unlike rebuilding the table it deletes nothing, so no ON DELETE fires.
ALTER TABLE folders DROP COLUMN color;
ALTER TABLE smart_folders DROP COLUMN color;
