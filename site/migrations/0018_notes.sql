-- 留言板 on the 概览 page (2026-10-15): short notes the team leaves each other — what needs organizing first,
-- what not to touch yet, what is not finished. Like a whiteboard, anyone in the team may write, edit, pin or
-- delete any note; who wrote it and who changed it last is shown. Not part of the catalogue's history.
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  author     TEXT NOT NULL,              -- email (the name is looked up in admins when shown)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  edited_by  TEXT,
  edited_at  TEXT
);
CREATE INDEX notes_order ON notes (pinned DESC, created_at DESC);
