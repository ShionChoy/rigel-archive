-- 版本页与公开页改版, 第 1 期: edition types are a list the admins keep (no fixed 7 slots per release),
-- every edition has an attachments folder (附件), and the pictures embedded in audio files are stored
-- once per picture (a cover shared by 15 tracks is one row).

-- The types (版本类型): the 7 built-in ones keep their ids (the import rules and their suggestions use
-- them) and become ordinary entries that can be renamed, reordered or deleted. `missing_board`: editions
-- of this type are listed on the 缺档看板.
ALTER TABLE slot_types ADD COLUMN missing_board INTEGER NOT NULL DEFAULT 1;

-- An edition's attachments folder: a plain folder directly under the edition's folder (renamable; it
-- goes with the edition and cannot be moved out or deleted on its own). One per edition.
ALTER TABLE folders ADD COLUMN extras INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX folders_extras ON folders (parent_id) WHERE extras = 1;

-- ---------------------------------------------------------------------------------------- the old slots
-- Each release had 7 slots with a status (release_slots). They are no longer used; what they said is kept:
--   * a slot 缺档 / 部分缺档 without an edition becomes an edition of that type with that status (its
--     note goes with it), so it stays on the 缺档看板;
--   * every other slot with a note, and 未发行 / 预定 ones, go into the release's admin note.
-- The table itself stays until the new pages have been checked.

-- The notes first (before the editions below exist).
UPDATE releases SET note = trim(coalesce(note || char(10) || char(10), '') || '【原版本栏位】' || char(10) || (
  SELECT group_concat(line, char(10)) FROM (
    SELECT st.name_zh || ' · ' || CASE s.status
             WHEN 'collected' THEN '已收录' WHEN 'partial' THEN '部分缺档' WHEN 'missing' THEN '缺档'
             WHEN 'unreleased' THEN '未发行' WHEN 'planned' THEN '预定' WHEN 'not_applicable' THEN '不适用' ELSE '待确认' END
           || coalesce(' ' || s.planned_date, '') || coalesce('：' || s.note, '') AS line
    FROM release_slots s JOIN slot_types st ON st.id = s.slot
    WHERE s.release_id = releases.id AND (s.note IS NOT NULL OR s.status IN ('unreleased', 'planned'))
      AND NOT (s.status IN ('missing', 'partial')
               AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.release_id = s.release_id AND e.slot = s.slot))
    ORDER BY st.sort)))
WHERE EXISTS (
  SELECT 1 FROM release_slots s WHERE s.release_id = releases.id AND (s.note IS NOT NULL OR s.status IN ('unreleased', 'planned'))
    AND NOT (s.status IN ('missing', 'partial')
             AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.release_id = s.release_id AND e.slot = s.slot)));

INSERT INTO editions (id, release_id, slot, name, status, note, sort)
SELECT 'e_' || lower(hex(randomblob(8))), s.release_id, s.slot, st.name_zh, s.status, s.note, 0
FROM release_slots s JOIN slot_types st ON st.id = s.slot
WHERE s.status IN ('missing', 'partial')
  AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.release_id = s.release_id AND e.slot = s.slot);

-- Their folders in the 整理台's tree (every release has its folder since 0007).
INSERT INTO folders (id, parent_id, type, edition_id)
SELECT 'fd_' || lower(hex(randomblob(8))), (SELECT f.id FROM folders f WHERE f.release_id = e.release_id), 'edition', e.id
FROM editions e
WHERE NOT EXISTS (SELECT 1 FROM folders f WHERE f.edition_id = e.id)
  AND EXISTS (SELECT 1 FROM folders f WHERE f.release_id = e.release_id);

-- ---------------------------------------------------------------------------------------- 附件
-- A plain folder named 附件 already under an edition becomes its attachments folder; the others get one.
UPDATE folders SET extras = 1
WHERE type = 'plain' AND name = '附件' AND parent_id IN (SELECT id FROM folders WHERE type = 'edition');

INSERT INTO folders (id, parent_id, type, name, extras)
SELECT 'fd_' || lower(hex(randomblob(8))), f.id, 'plain', '附件', 1
FROM folders f
WHERE f.type = 'edition' AND NOT EXISTS (SELECT 1 FROM folders x WHERE x.parent_id = f.id AND x.extras = 1);

-- ---------------------------------------------------------------------------------------- embedded pictures
-- A picture embedded in audio files, stored once under pictures/<sha256> (the image's own hash).
CREATE TABLE pictures (
  sha256     TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  mime       TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- What an audio content carries itself (文件原值): its tags and pictures, read from the head (and tail) of
-- the stored file by the site. One row per content, like the derived files.
--   tags      {"title": ["…"], "artist": ["…", "…"], …} in the site's tag names (Picard's)
--   native    [[field, value], …] as the file stores them (for the file page)
--   pictures  [{"sha256": …, "type": 3, "description": "…"}, …] in file order
--   cover     the front cover (type 3), else the first picture
CREATE TABLE embedded (
  sha256   TEXT PRIMARY KEY,
  version  INTEGER NOT NULL,
  format   TEXT,
  tags     TEXT NOT NULL DEFAULT '{}',
  native   TEXT NOT NULL DEFAULT '[]',
  pictures TEXT NOT NULL DEFAULT '[]',
  cover    TEXT REFERENCES pictures(sha256),
  error    TEXT,
  read_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX embedded_version ON embedded (version);
