// Preview clips (设计文档「文件权限方案 · 试听片段」): a track set to 「仅试听」 plays only a part of it, cut by
// the processing program (task «clip», tools/ra derive.py clip) as FLAC and AAC with a short fade. This file is
// the site's side: which parts the files want (their access, lib/access.ts, with a share of the track turned
// into seconds by its length), the parts already cut (table clips), and what the program reports.

import { clipSpan, parseClip } from './access';
import { parseFormat } from './db';
import type { ClipFile } from './playback';

/** The clips cut from these contents, by content. */
export async function clipsFor(database: D1Database, shas: (string | null)[]): Promise<Map<string, ClipFile[]>> {
  const out = new Map<string, ClipFile[]>();
  const list = [...new Set(shas.filter((s): s is string => !!s))];
  if (list.length === 0) return out;
  const { results } = await database
    .prepare('SELECT sha256, from_ms, to_ms, kind, key, size, info FROM clips WHERE sha256 IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(list))
    .all<{ sha256: string; from_ms: number; to_ms: number; kind: 'lossless' | 'lossy'; key: string; size: number; info: string | null }>();
  for (const r of results) {
    const mine = out.get(r.sha256) ?? [];
    mine.push({ kind: r.kind, key: r.key, size: r.size, info: r.info, from: r.from_ms / 1000, to: r.to_ms / 1000 });
    out.set(r.sha256, mine);
  }
  return out;
}

export interface Span { from_ms: number; to_ms: number }

/**
 * SQL on files f joined with its edition e: an audio file whose access asks for a clip (open by its rights,
 * filed, stored). Clips are cut whether or not the work is published yet, so they are ready when it is.
 */
const WANTS_CLIP = `f.kind = 'audio' AND f.blob_key IS NOT NULL AND f.sha256 IS NOT NULL AND f.state IN ('classified', 'published')
  AND f.dup_of IS NULL AND f.sealed_in IS NULL AND f.rights IN ('own', 'licensed') AND coalesce(f.pub_visible, e.pub_visible) = 1
  AND coalesce(f.pub_play, e.pub_play) = 'clip'`;

/** The parts each content's files want (in milliseconds), by content; `only` limits it to some contents. */
export async function wantedSpans(database: D1Database, only?: string[]): Promise<Map<string, Span[]>> {
  const { results } = await database
    .prepare(
      `SELECT f.sha256, f.format, coalesce(f.pub_clip, e.pub_clip) AS clip FROM files f JOIN editions e ON e.id = f.edition_id
       WHERE ${WANTS_CLIP} ${only ? 'AND f.sha256 IN (SELECT value FROM json_each(?))' : ''}`,
    )
    .bind(...(only ? [JSON.stringify(only)] : []))
    .all<{ sha256: string; format: string | null; clip: string }>();
  const out = new Map<string, Span[]>();
  for (const r of results) {
    const clip = parseClip(r.clip);
    if (!clip) continue;
    const span = clipSpan(clip, parseFormat(r.format).duration ?? null);
    const s = { from_ms: Math.round(span.from * 1000), to_ms: Math.round(span.to * 1000) };
    const list = out.get(r.sha256) ?? [];
    if (!list.some((x) => x.from_ms === s.from_ms && x.to_ms === s.to_ms)) list.push(s);
    out.set(r.sha256, list.sort((a, b) => a.from_ms - b.from_ms || a.to_ms - b.to_ms));
  }
  return out;
}

/** How a set of parts is named in media_tasks.spec (the same set, the same text). */
export const specOf = (spans: Span[]) => spans.map((s) => `${s.from_ms}-${s.to_ms}`).join(',');

/** Clips a run reports: one per part and version, stored under derived/clip/<sha256>/. */
export interface ClipOutput extends Span { kind: 'lossless' | 'lossy'; key: string; size: number; info: unknown }

/** Check what the processing program says it stored for this content. */
export async function checkClips(media: R2Bucket, sha256: string, raw: unknown): Promise<ClipOutput[]> {
  if (!Array.isArray(raw)) throw new Error('clips 必须是列表');
  const prefix = `derived/clip/${sha256}/`;
  const list = raw.map((o) => {
    const x = o as Record<string, unknown>;
    const out = {
      from_ms: Number(x.from_ms), to_ms: Number(x.to_ms), kind: String(x.kind ?? '') as ClipOutput['kind'], key: String(x.key ?? ''), size: Number(x.size), info: x.info ?? null,
    };
    if (!Number.isInteger(out.from_ms) || !Number.isInteger(out.to_ms) || out.from_ms < 0 || out.to_ms <= out.from_ms) throw new Error('片段范围无效');
    if (out.kind !== 'lossless' && out.kind !== 'lossy') throw new Error(`未知的片段格式：${out.kind}`);
    if (!out.key.startsWith(prefix) || !/^[\w.-]+$/.test(out.key.slice(prefix.length))) throw new Error(`片段位置无效：${out.key}`);
    return out;
  });
  const heads = await Promise.all(list.map((o) => media.head(o.key)));
  heads.forEach((h, i) => {
    if (!h) throw new Error(`存储里没有 ${list[i].key}`);
    if (h.size !== list[i].size) throw new Error(`${list[i].key} 的大小与报告不符`);
  });
  return list;
}

/**
 * Save the clips cut from a content, then drop its clips no file wants any more (their rows and stored
 * files). Returns the statements that also mark the task done (the caller adds them to the same batch).
 */
export async function saveClips(database: D1Database, media: R2Bucket, sha256: string, clips: ClipOutput[], done: D1PreparedStatement): Promise<void> {
  await database.batch([
    ...clips.map((c) =>
      database
        .prepare(
          `INSERT INTO clips (sha256, from_ms, to_ms, kind, key, size, info) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (sha256, from_ms, to_ms, kind) DO UPDATE SET key = excluded.key, size = excluded.size, info = excluded.info,
             created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
        )
        .bind(sha256, c.from_ms, c.to_ms, c.kind, c.key, c.size, c.info == null ? null : JSON.stringify(c.info)),
    ),
    done,
  ]);
  await dropUnwanted(database, media, [sha256]);
}

/** Delete the clips of these contents that no file wants now. */
export async function dropUnwanted(database: D1Database, media: R2Bucket, shas: string[]): Promise<number> {
  if (shas.length === 0) return 0;
  const wanted = await wantedSpans(database, shas);
  const { results } = await database
    .prepare('SELECT sha256, from_ms, to_ms, kind, key FROM clips WHERE sha256 IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(shas))
    .all<{ sha256: string; from_ms: number; to_ms: number; kind: string; key: string }>();
  const stale = results.filter((c) => !(wanted.get(c.sha256) ?? []).some((s) => s.from_ms === c.from_ms && s.to_ms === c.to_ms));
  if (stale.length === 0) return 0;
  await database.batch(stale.map((c) => database.prepare('DELETE FROM clips WHERE sha256 = ? AND from_ms = ? AND to_ms = ? AND kind = ?').bind(c.sha256, c.from_ms, c.to_ms, c.kind)));
  await Promise.all(stale.map((c) => media.delete(c.key)));
  return stale.length;
}
