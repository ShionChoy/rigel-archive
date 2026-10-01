// 文件权限 (设计文档「文件权限方案」): what visitors may do with a file. Every edition has default access
// for its files and a file may set any part itself (NULL: as its edition). Its rights cap all of it:
// own and licensed files are open as set, third-party ones are listed by name at most, files whose rights
// are not set are not shown at all.
//
//   visible   listed on the public site at all
//   play      full / clip (a preview clip only; audio — other files take it as full) / none (listed by name)
//   clip      the preview clip's range: «start+length», start in seconds or a share of the track («30%»)
//   quality   the best sound offered: original / lossless (the stream FLAC) / lossy (AAC)
//   download  for members, once accounts come (第 3 阶段)
//
// Nothing here touches the database or the runtime, so the rules can be tried with plain Node.

import type { Rights } from './constants';

export const PLAYS = ['full', 'clip', 'none'] as const;
export type Play = (typeof PLAYS)[number];
export const QUALITIES = ['original', 'lossless', 'lossy'] as const;
export type Quality = (typeof QUALITIES)[number];
/** Higher is better: an offer is allowed when its rank is at most the cap's. */
export const QUALITY_RANK: Record<Quality, number> = { lossy: 0, lossless: 1, original: 2 };

/** The settings a file stores (NULL: as its edition). */
export interface FileAccessRow {
  pub_visible: number | null;
  pub_play: string | null;
  pub_clip: string | null;
  pub_quality: string | null;
  pub_download: number | null;
}
/** The settings an edition stores: whether it is shown, and its files' defaults. */
export interface EditionAccessRow {
  pub_shown: number;
  pub_visible: number;
  pub_play: string;
  pub_clip: string;
  pub_quality: string;
  pub_download: number;
}
export const FILE_ACCESS_FIELDS = ['pub_visible', 'pub_play', 'pub_clip', 'pub_quality', 'pub_download'] as const;
export type AccessField = (typeof FILE_ACCESS_FIELDS)[number];
export const EDITION_ACCESS_FIELDS = ['pub_shown', ...FILE_ACCESS_FIELDS] as const;

export const DEFAULT_CLIP = '0+60';
export const CLIP_LENGTH = { min: 10, max: 600 } as const;
/** An edition made before migration 0014, or before its row is read: everything open. */
export const OPEN_EDITION: EditionAccessRow = { pub_shown: 1, pub_visible: 1, pub_play: 'full', pub_clip: DEFAULT_CLIP, pub_quality: 'original', pub_download: 1 };

// ------------------------------------------------------------------------------------------ clip ranges

export interface Clip {
  start: number; // seconds, or a share of the track (percent)
  percent: boolean;
  length: number; // seconds
}

const CLIP_TEXT = /^(\d{1,5}(?:\.\d{1,3})?)(%?)\+(\d{1,3})$/;

/** A stored range («90+60», «30%+60»); null when it is not one. */
export function parseClip(text: string | null | undefined): Clip | null {
  const m = CLIP_TEXT.exec(String(text ?? '').trim());
  if (!m) return null;
  const clip = { start: Number(m[1]), percent: m[2] === '%', length: Number(m[3]) };
  if (clip.percent && clip.start > 100) return null;
  if (clip.length < CLIP_LENGTH.min || clip.length > CLIP_LENGTH.max) return null;
  return clip;
}

export const formatClip = (c: Clip) => `${+c.start.toFixed(3)}${c.percent ? '%' : ''}+${Math.round(c.length)}`;

/**
 * A range typed in the admin: the start as «1:30», «90» (seconds) or «30%», the length in seconds. Null
 * when either is not understood or the length is out of bounds.
 */
export function clipFromInput(start: string, length: string): string | null {
  const s = start.trim().replace(/：/g, ':').replace(/％/g, '%');
  let clip: Clip;
  const pct = /^(\d{1,3}(?:\.\d+)?)\s*%$/.exec(s);
  const time = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (pct) clip = { start: Number(pct[1]), percent: true, length: 0 };
  else if (time) clip = { start: Number(time[1] ?? 0) * 3600 + Number(time[2]) * 60 + Number(time[3]), percent: false, length: 0 };
  else if (/^\d{1,5}(?:\.\d+)?$/.test(s)) clip = { start: Number(s), percent: false, length: 0 };
  else if (s === '') clip = { start: 0, percent: false, length: 0 };
  else return null;
  if (clip.percent && clip.start > 100) return null;
  if (!clip.percent && time && Number(time[3]) >= 60) return null;
  const len = Number(length.trim());
  if (!Number.isFinite(len) || len < CLIP_LENGTH.min || len > CLIP_LENGTH.max) return null;
  clip.length = Math.round(len);
  return formatClip(clip);
}

/**
 * Where a range falls in a track of `duration` seconds: a start past the end moves the clip back so that it
 * keeps its length; a track shorter than the clip is played whole. Without a duration a share starts at 0.
 */
export function clipSpan(clip: Clip, duration: number | null | undefined): { from: number; to: number } {
  const total = duration && duration > 0 ? duration : null;
  let from = clip.percent ? (total ? (total * clip.start) / 100 : 0) : clip.start;
  const length = total ? Math.min(clip.length, total) : clip.length;
  if (total) from = Math.max(0, Math.min(from, total - length));
  from = Math.round(from * 1000) / 1000;
  return { from, to: Math.round((from + length) * 1000) / 1000 };
}

// ------------------------------------------------------------------------------------------ what a file gets

/** How far a file's rights let it open at most. */
export type Ceiling = 'open' | 'listed' | 'hidden';
export const ceilingOf = (rights: Rights | string): Ceiling =>
  rights === 'own' || rights === 'licensed' ? 'open' : rights === 'third_party' ? 'listed' : 'hidden';

export interface Access {
  /** On the public site at all (the edition being shown is checked apart from this). */
  visible: boolean;
  play: Play;
  clip: Clip;
  quality: Quality;
  download: boolean;
  /** Which settings the file sets itself (the rest follow its edition). */
  own: Record<'visible' | 'play' | 'clip' | 'quality' | 'download', boolean>;
  /** What the rights allow at most; settings beyond it are held back. */
  ceiling: Ceiling;
}

const isPlay = (v: unknown): v is Play => (PLAYS as readonly unknown[]).includes(v);
const isQuality = (v: unknown): v is Quality => (QUALITIES as readonly unknown[]).includes(v);

/** The settings a file has, its own or its edition's, before its rights cap them. */
export function settingsOf(file: Partial<FileAccessRow>, edition: EditionAccessRow | null | undefined) {
  const ed = edition ?? OPEN_EDITION;
  const own = {
    visible: file.pub_visible === 0 || file.pub_visible === 1,
    play: isPlay(file.pub_play),
    clip: !!parseClip(file.pub_clip),
    quality: isQuality(file.pub_quality),
    download: file.pub_download === 0 || file.pub_download === 1,
  };
  return {
    own,
    visible: (own.visible ? file.pub_visible : ed.pub_visible) === 1,
    play: (own.play ? file.pub_play : isPlay(ed.pub_play) ? ed.pub_play : 'full') as Play,
    clip: (own.clip ? parseClip(file.pub_clip) : parseClip(ed.pub_clip)) ?? parseClip(DEFAULT_CLIP)!,
    quality: (own.quality ? file.pub_quality : isQuality(ed.pub_quality) ? ed.pub_quality : 'original') as Quality,
    download: (own.download ? file.pub_download : ed.pub_download) === 1,
  };
}

/** What visitors may do with a file: its settings (own, else its edition's), capped by its rights. */
export function accessOf(file: { rights: string; kind: string } & Partial<FileAccessRow>, edition: EditionAccessRow | null | undefined): Access {
  const s = settingsOf(file, edition);
  const ceiling = ceilingOf(file.rights);
  const visible = s.visible && ceiling !== 'hidden';
  // A preview clip is for sound; any other file with it is open as it is.
  const wanted: Play = s.play === 'clip' && file.kind !== 'audio' ? 'full' : s.play;
  return {
    visible,
    play: visible && ceiling === 'open' ? wanted : 'none',
    clip: s.clip,
    quality: s.quality,
    download: visible && ceiling === 'open' && s.download,
    own: s.own,
    ceiling,
  };
}

/** Listed on the public site (by name at least). */
export const isListed = (a: Access) => a.visible;
/** Shown, read or played there (fully or as a clip). */
export const isOpen = (a: Access) => a.visible && a.play !== 'none';

// ------------------------------------------------------------------------------------------ the same in SQL

/**
 * SQL on files f joined with its edition e: listed on the public site (by name at least), whatever the
 * file's state (lib/public/rules.ts adds that).
 */
export const LISTED_SQL = "f.rights IN ('own', 'licensed', 'third_party') AND coalesce(f.pub_visible, e.pub_visible) = 1";
/** SQL on files f and edition e: shown, read or played there (fully or as a clip). */
export const OPEN_SQL = "f.rights IN ('own', 'licensed') AND coalesce(f.pub_visible, e.pub_visible) = 1 AND coalesce(f.pub_play, e.pub_play) != 'none'";
