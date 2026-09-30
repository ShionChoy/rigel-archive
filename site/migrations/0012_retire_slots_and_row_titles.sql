-- Two leftovers retire (2026-09-30):
--
-- 1. edition_tracks.title: since 0009 a track's title in an edition is the row's 标题 tag (tags.title), which
--    every page reads first. A row whose title was only in the old column gets it as its tag, then the column goes.
-- 2. release_slots: each release's 7 fixed slots, unused since 0008 (what they said became editions and release
--    notes then). Nothing reads them any more; old revisions of them are skipped when a batch is undone.
--
-- DROP COLUMN and DROP TABLE only: no table is rebuilt (on D1 that would cascade-delete the rows pointing at it).

UPDATE edition_tracks SET tags = json_set(tags, '$.title', json_array(title))
WHERE title IS NOT NULL AND title != '' AND json_extract(tags, '$.title') IS NULL;

ALTER TABLE edition_tracks DROP COLUMN title;

DROP TABLE release_slots;
