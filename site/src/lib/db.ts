import { env } from 'cloudflare:workers';
import type { FileState, ReleaseKind, Rights, Slot, SlotStatus } from './constants';

export const db = (): D1Database => env.DB;

export interface ReleaseRow {
  id: string;
  catalog_no: string | null;
  era_id: string;
  kind: ReleaseKind;
  series: string | null;
  title: string;
  title_reading: string | null;
  release_date: string | null;
  event: string | null;
  track_count: number | null;
  price: string | null;
  aliases: string;
  links: string;
  description: string | null;
  note: string | null;
  cover_file_id: string | null;
  state: 'draft' | 'published';
}

export interface TrackRow {
  id: string;
  release_id: string;
  disc: number;
  position: number;
  title: string;
  song_id: string | null;
  version_label: string | null;
  duration_ms: number | null;
  credits: string | null;
  note: string | null;
}

export interface SlotRow {
  release_id: string;
  slot: Slot;
  status: SlotStatus;
  planned_date: string | null;
  note: string | null;
}

export interface Suggestion {
  rule: string;
  confidence: number;
  release_id?: string;
  slot?: Slot;
  rights?: Rights;
  role?: string;
  state?: FileState;
  note?: string;
}

export interface FileRow {
  id: string;
  origin: 'nas' | 'upload';
  source_path: string | null;
  dir: string;
  member_of: string | null;
  member_path: string | null;
  name: string;
  ext: string;
  size: number;
  mtime: string | null;
  sha256: string | null;
  blob_key: string | null;
  kind: string;
  format: string | null;
  pcm_md5: string | null;
  rights: Rights;
  state: FileState;
  release_id: string | null;
  slot: Slot | null;
  track_id: string | null;
  role: string | null;
  dup_of: string | null;
  suggest: string | null;
  download_name: string | null;
  note: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  checked_at: string | null;
  source_seen: string | null;
  replaces: string | null;
}

/** Machine-read facts about a file (`format` column), written by the import tools. */
export interface FileFormat {
  // archives and disc images (ra extract)
  archive?: string;
  files?: number;
  status?: 'ok' | 'encrypted' | 'error';
  encoding?: string;
  error?: string;
  // audio, video and images (ra probe)
  codec?: string;
  lossless?: boolean;
  bits?: number;
  rate?: number;
  channels?: number;
  duration?: number;
  kbps?: number;
  cover?: boolean;
  container?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  tags?: Record<string, string>;
  probe_error?: string;
  // uploads (ra worker)
  upload_error?: string;
}

export function parseFormat(raw: string | null): FileFormat {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FileFormat;
  } catch {
    return {};
  }
}

export function parseSuggestion(raw: string | null): Suggestion | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Suggestion;
  } catch {
    return null;
  }
}

/** The patch that "accept suggestion" applies, or null when the suggestion decides nothing. */
export function suggestionPatch(s: Suggestion | null): Record<string, string | null> | null {
  if (!s) return null;
  if (s.state === 'ignored') return { state: 'ignored' };
  if (!s.release_id && !s.rights) return null;
  return {
    release_id: s.release_id ?? null,
    slot: s.slot ?? null,
    rights: s.rights ?? 'unknown',
    role: s.role ?? null,
    state: 'classified',
  };
}

export interface ReleaseOption {
  id: string;
  label: string;
}

export async function releaseOptions(): Promise<ReleaseOption[]> {
  const { results } = await db()
    .prepare(
      `SELECT r.id, r.catalog_no, r.title FROM releases r JOIN eras e ON e.id = r.era_id
       ORDER BY e.sort, r.release_date DESC NULLS LAST, r.title`,
    )
    .all<{ id: string; catalog_no: string | null; title: string }>();
  return results.map((r) => ({ id: r.id, label: r.catalog_no ? `${r.catalog_no} ${r.title}` : r.title }));
}

export async function releaseLabels(): Promise<Map<string, string>> {
  return new Map((await releaseOptions()).map((o) => [o.id, o.label]));
}
