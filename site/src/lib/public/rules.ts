// What the public site shows (设计文档「公开站方案 · 公开规则」「文件权限方案」), in one place. Pages list
// and play only what passes here, and the media addresses they hand out are signed (lib/public/media.ts),
// so nothing else can be reached.
//
//   作品  published (草稿 only in the admin's 预览公开页)
//   版本  collected or partly collected, and 「在公开站显示本版」 on (缺档、预定、待确认 only in the admin)
//   文件  by its access (lib/access.ts): its own settings or its edition's, capped by its rights (own /
//         licensed as set; third_party listed by name at most; unknown not shown). Duplicates, replaced
//         files and members of kept-whole archives are never shown on their own.

import type { EditionStatus } from '../db';
import { LISTED_SQL, OPEN_SQL } from '../access';

export { accessOf, isListed, isOpen, type Access } from '../access';

/** SQL on `releases` r. */
export const PUBLIC_RELEASE = "r.state = 'published'";

export const PUBLIC_EDITION_STATUSES: EditionStatus[] = ['collected', 'partial'];
/** SQL on `editions` e. */
export const PUBLIC_EDITION = "e.status IN ('collected', 'partial') AND e.pub_shown = 1";
/** An edition the public site shows (the work being published is checked apart from this). */
export const isPublicEdition = (e: { status: EditionStatus; pub_shown?: number }) => PUBLIC_EDITION_STATUSES.includes(e.status) && e.pub_shown !== 0;

/**
 * SQL on `files` f: a filed file that stands for itself (whatever its access; the callers sort that out,
 * so that the admin's preview can say how many it left out).
 */
export const FILED_FILE = `f.state IN ('classified', 'published') AND f.dup_of IS NULL AND f.sealed_in IS NULL
  AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)`;

/** SQL on files f joined with its edition e: listed on the public site (by name at least). */
export const LISTED_FILE = `${FILED_FILE} AND ${LISTED_SQL}`;

/** SQL on files f joined with its edition e: shown, read or played on the public site (fully or as a clip). */
export const OPEN_FILE = `${FILED_FILE} AND ${OPEN_SQL}`;

/** Guests see pictures up to this size; larger originals are for downloading (第 3 阶段). */
export const PREVIEW_EDGE = 1600;
