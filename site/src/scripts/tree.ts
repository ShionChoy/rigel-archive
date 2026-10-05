// The file trees' rows, drawn in the browser the way components/desk/FolderTree.astro draws folders: the
// 整理台's 未归档 and 已归档 trees and the 「移动到…」 dialog look and behave alike (a triangle opens a
// folder; an open folder lists its subfolders, then its files). Files and original folders are fetched
// when a folder is opened (/admin/desk/tree).

import { t } from './i18n';

export interface TreeFile {
  id: string;
  name: string; // as shown (renamed, or the original name)
  orig: string;
  ext: string;
  kind: string;
  size: number;
  state: string;
  edition?: string;
  placed?: boolean;
  sug?: boolean;
  upload?: boolean;
  archive?: boolean;
  sealed?: boolean;
}

export interface TreeDir {
  name: string;
  path: string;
  n: number; // files to organize in it, at any depth
}

export interface FolderFiles {
  files: TreeFile[];
  more: number; // files not listed
}

export interface SourceLevel extends FolderFiles {
  dirs: TreeDir[];
}

const SVG = 'http://www.w3.org/2000/svg';

// The shapes of components/desk/FolderIcon.astro (keep the two alike).
const FOLDER_SHAPES: Record<string, string> = {
  era: '<path d="M3.5 1.5v13M3.5 2h9l-2.2 3.2L12.5 8.4h-9" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  release: '<circle cx="8" cy="8" r="6.6" fill="currentColor"/><circle cx="8" cy="8" r="1.9" fill="var(--panel, #fff)"/>',
  edition: '<rect x="1.5" y="4.5" width="10" height="10" rx="1.5" fill="currentColor"/><path d="M4.5 2h8a1.5 1.5 0 0 1 1.5 1.5v8" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  plain: '<path d="M1.2 3.6c0-.6.5-1.1 1.1-1.1h3.9l1.6 1.7h5.9c.6 0 1.1.5 1.1 1.1v7.6c0 .6-.5 1.1-1.1 1.1H2.3c-.6 0-1.1-.5-1.1-1.1z" fill="currentColor"/>',
};
// The shape of components/desk/FileIcon.astro: a sheet with a folded corner, coloured by the file's kind.
const FILE_SHAPE = '<path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>';

function svg(className: string, shape: string, size = 16): SVGSVGElement {
  const el = document.createElementNS(SVG, 'svg');
  el.setAttribute('class', className);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = shape;
  return el;
}

export const folderIcon = (kind: string, size = 16) => svg(`ficon ${kind}`, FOLDER_SHAPES[kind] ?? FOLDER_SHAPES.plain, size);
export const fileIcon = (kind: string, size = 16) => svg(`ficon file k-${kind}`, FILE_SHAPE, size);

/** Append children one by one (the Workers types clash with the DOM's variadic append here). */
export function put(parent: Element, ...children: Node[]): void {
  for (const c of children) parent.appendChild(c);
}

export function formatSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${u === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

function twisty(open: boolean | null): HTMLElement {
  const b = document.createElement(open === null ? 'span' : 'button');
  b.className = open === null ? 'twisty none' : 'twisty';
  if (b instanceof HTMLButtonElement) {
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('aria-label', t('展开或收起'));
  }
  return b;
}

/** A file's row: a leaf of its folder. `drag`: it can be dragged (the 整理台). */
export function fileNode(f: TreeFile, depth: number, drag = false): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'fnode leaf file';
  li.setAttribute('role', 'treeitem');
  const row = li.appendChild(document.createElement('div'));
  row.className = 'frow file-row';
  row.style.setProperty('--depth', String(depth));
  row.title = `${f.name} · ${formatSize(f.size)}`;
  const data: Record<string, string | undefined> = {
    id: f.id, kind: f.kind, ext: f.ext, name: f.name, orig: f.orig, state: f.state, edition: f.edition,
    placed: f.placed ? '1' : undefined, sug: f.sug ? '1' : undefined, upload: f.upload ? '1' : undefined,
    archive: f.archive ? '1' : undefined, sealed: f.sealed ? '1' : undefined,
  };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row.dataset[k] = v;
  if (drag) row.draggable = true;
  put(row, twisty(null), fileIcon(f.kind), Object.assign(document.createElement('span'), { className: 'fname', textContent: f.name }));
  if (f.state === 'ignored') row.classList.add('zero');
  return li;
}

/** «… N more» under a folder that lists only some of its files. */
export function moreNode(n: number, depth: number, href?: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'fnode leaf more-files';
  const row = li.appendChild(document.createElement('div'));
  row.className = 'frow muted small';
  row.style.setProperty('--depth', String(depth));
  row.appendChild(twisty(null));
  const text = t('还有 {n} 个文件', { n });
  if (href) {
    const a = row.appendChild(Object.assign(document.createElement('a'), { href, textContent: text }));
    a.dataset.nav = '';
  } else row.appendChild(document.createTextNode(text));
  return li;
}

/** An original folder in 未归档: opened with its triangle (its contents fetched then), dragged whole. */
export function dirNode(d: TreeDir, depth: number, open: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `fnode src${open ? ' open' : ''}`;
  li.dataset.src = d.path;
  li.setAttribute('role', 'treeitem');
  li.setAttribute('aria-expanded', String(open));
  const row = li.appendChild(document.createElement('div'));
  row.className = 'frow';
  row.dataset.src = d.path;
  row.draggable = true;
  row.style.setProperty('--depth', String(depth));
  row.title = d.path;
  const name = Object.assign(document.createElement('a'), { className: 'fname', textContent: d.name, href: `/admin/inbox?view=unplaced&dir=${encodeURIComponent(d.path)}` });
  name.dataset.nav = '';
  put(row, twisty(false), folderIcon('plain'), name, Object.assign(document.createElement('span'), { className: 'n', textContent: String(d.n) }));
  li.appendChild(Object.assign(document.createElement('ul'), { className: 'ftree' })).setAttribute('role', 'group');
  return li;
}

/** The files directly in these archive folders. */
export async function folderFiles(ids: string[]): Promise<Map<string, FolderFiles>> {
  const out = new Map<string, FolderFiles>();
  for (let i = 0; i < ids.length; i += 150) {
    const params = new URLSearchParams(ids.slice(i, i + 150).map((id) => ['folder', id]));
    const r = await fetch(`/admin/desk/tree?${params}`).catch(() => null);
    if (!r?.ok) continue;
    const body = (await r.json()) as { folders: Record<string, FolderFiles> };
    for (const [id, v] of Object.entries(body.folders)) out.set(id, v);
  }
  return out;
}

/** What 未归档 holds right below these original folders ('' is the top). */
export async function sourceLevels(paths: string[]): Promise<Map<string, SourceLevel>> {
  const out = new Map<string, SourceLevel>();
  for (let i = 0; i < paths.length; i += 100) {
    const params = new URLSearchParams(paths.slice(i, i + 100).map((p) => ['src', p]));
    const r = await fetch(`/admin/desk/tree?${params}`).catch(() => null);
    if (!r?.ok) continue;
    const body = (await r.json()) as { sources: Record<string, SourceLevel> };
    for (const [p, v] of Object.entries(body.sources)) out.set(p, v);
  }
  return out;
}
