// What the public site shows (设计文档「公开站方案 · 公开规则」), in one place. Pages list and play only
// what passes here, and the media addresses they hand out are signed (lib/public/media.ts), so nothing
// else can be reached.
//
//   作品  published (草稿 only in the admin's 预览公开页)
//   版本  collected or partly collected (缺档、预定、待确认 only in the admin)
//   文件  own / licensed: shown and played; third_party: listed by name only; unknown: not shown until
//         the organizers set its rights. Duplicates, replaced files and members of kept-whole archives are
//         never shown on their own.

import type { FileRow } from '../db';
import type { EditionStatus } from '../db';

/** SQL on `releases` r. */
export const PUBLIC_RELEASE = "r.state = 'published'";

export const PUBLIC_EDITION_STATUSES: EditionStatus[] = ['collected', 'partial'];
/** SQL on `editions` e. */
export const PUBLIC_EDITION = "e.status IN ('collected', 'partial')";

/**
 * SQL on `files` f: a filed file that stands for itself (whatever its rights; `isListed` / `isOpen` sort
 * those out, so that the admin's preview can say how many it left out).
 */
export const FILED_FILE = `f.state IN ('classified', 'published') AND f.dup_of IS NULL AND f.sealed_in IS NULL
  AND NOT EXISTS (SELECT 1 FROM files n WHERE n.replaces = f.id)`;

/** SQL on `files` f: shown and played on the public site. */
export const OPEN_FILE = `${FILED_FILE} AND f.rights IN ('own', 'licensed')`;

type Rights = Pick<FileRow, 'rights'>;

/** Shown and played (own and licensed files). */
export const isOpen = (f: Rights) => f.rights === 'own' || f.rights === 'licensed';

/** On the page at all: open files, and third-party ones by name only. */
export const isListed = (f: Rights) => isOpen(f) || f.rights === 'third_party';

/** Guests see pictures up to this size; larger originals are for downloading (第 3 阶段). */
export const PREVIEW_EDGE = 1600;
