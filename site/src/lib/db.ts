import { env } from 'cloudflare:workers';
import type { FileState, Rights } from './constants';

export const db = (): D1Database => env.DB;

export interface ReleaseRow {
  id: string;
  catalog_no: string | null;
  era_id: string;
  kind: string; // the nearest of the six original forms (CHECK-bound); the form itself is `form`
  form: string | null; // a release_forms id (lib/forms.ts)
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
  artist: string | null;
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
  external_ids: string;
}

export type EditionStatus = 'collected' | 'partial' | 'missing' | 'planned' | 'unknown';

export interface EditionRow {
  id: string;
  release_id: string;
  slot: string; // the edition's type (slot_types.id)
  name: string;
  catalog_no: string | null;
  release_date: string | null;
  source: string | null;
  status: EditionStatus;
  based_on: string | null;
  is_default: number;
  track_count: number | null;
  album_title: string | null;
  cover_file_id: string | null;
  external_ids: string;
  note: string | null;
  sort: number;
  // 文件权限 (migration 0014, lib/access.ts): shown on the public site, and its files' defaults
  pub_shown: number;
  pub_visible: number;
  pub_play: string;
  pub_clip: string;
  pub_quality: string;
  pub_download: number;
}

export interface EditionTrackRow {
  id: string;
  edition_id: string;
  disc: number;
  position: number;
  track_id: string;
  duration_ms: number | null;
  external_ids: string;
  tags: string; // JSON: the row's tags (its title among them) over the file's own (lib/tagging/model.ts)
  cover: string | null; // JSON: the row's chosen cover (lib/tags.ts parseCover)
}

export interface FolderRow {
  id: string;
  parent_id: string | null;
  type: 'plain' | 'era' | 'release' | 'edition';
  era_id: string | null; // the entity a typed folder is (plain folders: all three null)
  release_id: string | null;
  edition_id: string | null;
  name: string; // plain folders; typed folders show their entity's name
  description: string | null;
  readme_file_id: string | null;
  color: string | null;
  sort: number;
}

export interface Suggestion {
  rule: string;
  confidence: number;
  release_id?: string;
  slot?: string; // an edition type
  place?: string; // a place chosen when uploading (a fd: key, or era:/rel:/ed: of the entity's folder); folder then goes below it
  edition?: string; // name of the release's edition of this slot (made when missing)
  edition_catalog?: string;
  folder?: string; // folder path ('/'-separated) under the edition, release or era, or at the top
  era_id?: string; // where the folder hangs when there is no release
  seal?: boolean; // keep the archive whole
  readme?: boolean; // this file describes its folder
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
  slot: string | null;
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
  folder_id: string | null;
  edition_id: string | null;
  sealed: number;
  sealed_in: string | null;
  // 文件权限 (migration 0014, lib/access.ts): NULL follows the edition
  pub_visible: number | null;
  pub_play: string | null;
  pub_clip: string | null;
  pub_quality: string | null;
  pub_download: number | null;
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
