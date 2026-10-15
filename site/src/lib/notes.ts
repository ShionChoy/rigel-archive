// 留言板 on the 概览 page: notes the team leaves each other (migration 0018). Anyone in the team may write,
// edit, pin or delete any note, as on a whiteboard; the page shows who wrote it and who changed it last.

import { db } from './db';
import { UserError } from './i18n';
import { newId } from './ids';

export interface Note {
  id: string;
  body: string;
  pinned: number;
  author: string;
  author_name: string | null;
  created_at: string;
  edited_by: string | null;
  editor_name: string | null;
  edited_at: string | null;
}

const MAX = 2000;

function text(raw: string): string {
  const body = raw.replace(/\r\n?/g, '\n').trim();
  if (!body) throw new UserError('留言不能是空的');
  if (body.length > MAX) throw new UserError('留言太长（最多 {n} 字）', { n: MAX });
  return body;
}

/** Pinned notes first, then the newest. */
export async function listNotes(): Promise<Note[]> {
  const { results } = await db()
    .prepare(
      `SELECT n.id, n.body, n.pinned, n.author, a.name AS author_name, n.created_at, n.edited_by, e.name AS editor_name, n.edited_at
       FROM notes n LEFT JOIN admins a ON a.email = n.author LEFT JOIN admins e ON e.email = n.edited_by
       ORDER BY n.pinned DESC, n.created_at DESC LIMIT 200`,
    )
    .all<Note>();
  return results;
}

export async function addNote(actor: string, raw: string): Promise<void> {
  await db().prepare('INSERT INTO notes (id, body, author) VALUES (?, ?, ?)').bind(newId('n'), text(raw), actor).run();
}

async function change(sql: string, binds: unknown[]): Promise<void> {
  const r = await db().prepare(sql).bind(...binds).run();
  if (!r.meta.changes) throw new UserError('这条留言已经不在了（可能刚被别人删除）');
}

export function editNote(actor: string, id: string, raw: string): Promise<void> {
  return change(
    "UPDATE notes SET body = ?, edited_by = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    [text(raw), actor, id],
  );
}

export function pinNote(id: string, pinned: boolean): Promise<void> {
  return change('UPDATE notes SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
}

export function deleteNote(id: string): Promise<void> {
  return change('DELETE FROM notes WHERE id = ?', [id]);
}
