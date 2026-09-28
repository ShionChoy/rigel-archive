-- 作品形式 become a list the admins keep, like the edition types (0008): new forms, names in three
-- languages, their order, and deleting one no release uses.
--
-- releases.kind keeps its CHECK on the six original forms. Rebuilding releases to drop it is not safe on
-- D1: DROP TABLE deletes the rows first, and the ON DELETE CASCADE of editions, tracks, folders … fires
-- (defer_foreign_keys does not stop it). So the form is a new column; kind stays the nearest original
-- form (other for the new ones), and the import (ra seed) sets the form of the releases it adds.
CREATE TABLE release_forms (
  id      TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_ja TEXT NOT NULL,
  name_en TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

INSERT INTO release_forms (id, name_zh, name_ja, name_en, sort) VALUES
  ('album',    '专辑',          'アルバム',          'Album',          1),
  ('single',   '单曲',          'シングル',          'Single',         2),
  ('dl_card',  'DEMO / DL 卡',  'DEMO / DL カード',  'Demo / DL Card', 3),
  ('web',      '网络发表',       'ネット公開',         'Web Release',    4),
  ('game_bgm', '游戏 BGM',      'ゲーム BGM',        'Game BGM',       5),
  ('other',    '其他',          'その他',            'Other',          6);

ALTER TABLE releases ADD COLUMN form TEXT REFERENCES release_forms(id);
UPDATE releases SET form = kind;
CREATE INDEX releases_form ON releases (form);
