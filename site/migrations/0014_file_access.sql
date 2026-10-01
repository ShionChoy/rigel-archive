-- What visitors may do with each file (2026-09-30; 设计文档「文件权限方案」):
--
-- 1. Every edition gets 「在公开站显示本版」 (pub_shown) and its files' default access: visible, play
--    (full / clip = a preview clip only / none), the preview clip's range, the best sound offered
--    (original / lossless = the stream FLAC / lossy = AAC) and download. The defaults open everything, as the
--    public site did before.
-- 2. A file may set any of these itself; NULL follows its edition. A file's rights still cap what is open:
--    third-party files are listed by name at most, files whose rights are not set are not shown at all
--    (src/lib/access.ts).
-- 3. meta.media_epoch: part of every public media address and its signature; a change that may close
--    something visitors could reach counts it up, so the addresses handed out before stop working at once
--    (src/lib/public/media.ts, ChangeSet).
--
-- A clip range is «start+length»: start in seconds («90») or as a share of the track («30%»), length in seconds.

ALTER TABLE editions ADD COLUMN pub_shown INTEGER NOT NULL DEFAULT 1 CHECK (pub_shown IN (0, 1));
ALTER TABLE editions ADD COLUMN pub_visible INTEGER NOT NULL DEFAULT 1 CHECK (pub_visible IN (0, 1));
ALTER TABLE editions ADD COLUMN pub_play TEXT NOT NULL DEFAULT 'full' CHECK (pub_play IN ('full', 'clip', 'none'));
ALTER TABLE editions ADD COLUMN pub_clip TEXT NOT NULL DEFAULT '0+60';
ALTER TABLE editions ADD COLUMN pub_quality TEXT NOT NULL DEFAULT 'original' CHECK (pub_quality IN ('original', 'lossless', 'lossy'));
ALTER TABLE editions ADD COLUMN pub_download INTEGER NOT NULL DEFAULT 1 CHECK (pub_download IN (0, 1));

ALTER TABLE files ADD COLUMN pub_visible INTEGER CHECK (pub_visible IN (0, 1));
ALTER TABLE files ADD COLUMN pub_play TEXT CHECK (pub_play IN ('full', 'clip', 'none'));
ALTER TABLE files ADD COLUMN pub_clip TEXT;
ALTER TABLE files ADD COLUMN pub_quality TEXT CHECK (pub_quality IN ('original', 'lossless', 'lossy'));
ALTER TABLE files ADD COLUMN pub_download INTEGER CHECK (pub_download IN (0, 1));

INSERT INTO meta (key, value) VALUES ('media_epoch', '1') ON CONFLICT (key) DO NOTHING;
