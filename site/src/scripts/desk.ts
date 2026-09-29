// The 整理台 in the browser (pages/admin/inbox.astro): selection, the inspector, the right-click menu,
// drag and drop, the keyboard, and moving between folders without reloading the page. The server does
// all the work; after each action the page's parts are fetched again and swapped in.
import { t } from './i18n';
import { tagDialog } from './tag-dialog';
import { initPreviews as initPreviewsIn } from './previews';
import { initTextPreviews as initTextIn } from './text-preview';
import { openPicker, recentPlaces, rememberPlace, resetPickerOptions } from './place-picker';
import {
  batchBox, closeMenu, confirmBox, conflictBox, guideBox, helpBox, openMenu, previewBox, renameBox, smartBox, toast, typeBox,
  type MenuEntry, type RenameFile, type RuleSet,
} from './desk-ui';

type Kind = 'plain' | 'era' | 'release' | 'edition';
interface FolderOpt { id: string; parent: string | null; kind: Kind; name: string; path: string; release?: string; edition?: string; extras?: boolean }
interface DeskData {
  loc: string;
  view: string;
  dir: string;
  sub: boolean;
  total: number;
  layout: 'list' | 'grid';
  folders: FolderOpt[];
  quick: string[];
  smart: { id: string; name: string; rules: RuleSet }[];
  releases: { id: string; label: string }[];
  ruleFields: { id: string; label: string; ops: string[]; value: string }[];
  ruleOps: Record<string, string>;
  kinds: { id: string; label: string }[];
  rights: { id: string; label: string }[];
  states: { id: string; label: string }[];
  origins: { id: string; label: string }[];
  suggestKinds: { id: string; label: string }[];
  guess: Record<string, { catalog_no: string | null; title: string }>;
  slots: { id: string; label: string }[];
}

// The Workers types clash with the DOM's ParentNode here; these take any element.
const initPreviews = (el: Element) => initPreviewsIn(el as unknown as ParentNode);
const initTextPreviews = (el: Element) => initTextIn(el as unknown as ParentNode);

let data: DeskData;
let folders = new Map<string, FolderOpt>();
let kids = new Map<string | null, string[]>();
let lastBatch: string | null = null;
let clipboard: { files: string[]; folders: string[] } | null = null;
let anchor: HTMLElement | null = null;
let baseInspector = '';

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<E>(sel)];
const store = {
  get<V>(key: string, fallback: V): V {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as V);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode: nothing is remembered
    }
  },
};

function readData() {
  data = JSON.parse($('#desk-data')?.textContent ?? '{}') as DeskData;
  folders = new Map(data.folders.map((f) => [f.id, f]));
  kids = new Map();
  for (const f of data.folders) kids.set(f.parent, [...(kids.get(f.parent) ?? []), f.id]);
}

const folderKey = (id: string) => `fd:${id}`;
const currentFolder = () => (data.loc.startsWith('fd:') ? data.loc.slice(3) : null);
const nameOf = (id: string | null) => (id ? folders.get(id)?.path ?? id : t('顶层'));

// ------------------------------------------------------------------------------------------ rules for folders (as the server's)

function ancestorsOf(id: string | null): FolderOpt[] {
  const out: FolderOpt[] = [];
  for (let f = id ? folders.get(id) : undefined; f && out.length < 64; f = f.parent ? folders.get(f.parent) : undefined) out.push(f);
  return out;
}

function below(id: string): FolderOpt[] {
  const out: FolderOpt[] = [];
  const walk = (x: string) => {
    for (const k of kids.get(x) ?? []) {
      out.push(folders.get(k)!);
      walk(k);
    }
  };
  walk(id);
  return out;
}

function contextOf(id: string | null): { era: boolean; release: boolean } {
  const chain = ancestorsOf(id);
  return { era: chain.some((f) => f.kind === 'era'), release: chain.some((f) => f.kind === 'release' || f.kind === 'edition') };
}

/** Why this folder cannot go under that parent (null = it can); the server checks again. */
function placeProblem(id: string, parent: string | null): string | null {
  const f = folders.get(id);
  if (!f) return t('找不到这个文件夹');
  if (parent && (parent === id || ancestorsOf(parent).some((a) => a.id === id))) return t('不能把文件夹移到它自己里面');
  if (f.extras) return f.parent === parent ? null : t('附件文件夹不能移出所在的版本');
  if (f.kind === 'era') return parent ? t('名义只能放在最顶层') : null;
  if (f.kind === 'edition') return parent && folders.get(parent)?.kind === 'release' ? null : t('版本只能放在作品的下一层');
  if (f.kind === 'release' || below(id).some((x) => x.kind === 'release')) {
    const ctx = contextOf(parent);
    if (!ctx.era) return t('作品要放在某个名义里（中间可以隔着普通文件夹）');
    if (ctx.release) return t('作品不能放进另一个作品或版本里');
  }
  return null;
}

// ------------------------------------------------------------------------------------------ talking to the server

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-request': '1' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

let busy = false;

/** A folder operation; asks about same-name folders and confirmations, then shows the result. */
async function folderOp(body: Record<string, unknown>, opts: { quiet?: boolean; after?: (r: Record<string, unknown>) => void } = {}): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try {
    let r = await postJson('/admin/desk/folder', body);
    if (!r.ok && Array.isArray(r.conflict)) {
      const mode = await conflictBox(r.conflict as string[]);
      if (!mode) return false;
      r = await postJson('/admin/desk/folder', { ...body, mode });
    }
    if (!r.ok && typeof r.confirm === 'string') {
      if (!(await confirmBox(r.confirm, t('确定删除')))) return false;
      r = await postJson('/admin/desk/folder', { ...body, confirmed: true });
    }
    if (!r.ok) {
      toast(String(r.err ?? t('操作失败')), { error: true });
      return false;
    }
    lastBatch = (r.batch as string | null) ?? lastBatch;
    if (!opts.quiet || r.batch) toast(String(r.msg ?? ''), { batch: r.batch as string | null, onUndo: undo });
    await refresh();
    opts.after?.(r);
    return true;
  } finally {
    busy = false;
  }
}

/** A file action (the 整理台's own POST): on the given files, or on the whole list when 「全部」 is ticked. */
async function fileAction(action: string, ids: string[], extra: Record<string, string> = {}): Promise<boolean> {
  const all = $<HTMLInputElement>('[data-scope-all]')?.checked;
  if (!all && ids.length === 0) {
    toast(t('先选中文件'), { error: true });
    return false;
  }
  if (busy) return false;
  busy = true;
  const body = new FormData();
  body.append('action', action);
  if (all) body.append('scope', 'filter');
  else for (const id of ids) body.append('ids', id);
  for (const [k, v] of Object.entries(extra)) body.append(k, v);
  toast(t('处理中…'));
  try {
    const r = await fetch(`/admin/inbox${location.search}`, { method: 'POST', body, headers: { accept: 'application/json', 'x-admin-request': '1' } });
    const j = (await r.json().catch(() => ({ ok: false, err: t('操作失败') }))) as { ok: boolean; msg?: string; err?: string; batch?: string | null };
    if (!j.ok) {
      toast(j.err ?? t('操作失败'), { error: true });
      return false;
    }
    lastBatch = j.batch ?? lastBatch;
    toast(j.msg ?? '', { batch: j.batch ?? null });
    await refresh(true);
    return true;
  } finally {
    busy = false;
  }
}

async function undo(batch: string | null = lastBatch) {
  if (!batch) {
    toast(t('没有可以撤销的操作'), { error: true });
    return;
  }
  const body = new FormData();
  body.append('batch', batch);
  const r = await fetch('/admin/history', { method: 'POST', body, headers: { accept: 'application/json' } });
  const j = (await r.json().catch(() => ({ ok: false, err: t('撤销失败') }))) as { ok: boolean; msg?: string; err?: string };
  toast(j.ok ? j.msg ?? t('已撤销') : j.err ?? t('撤销失败'), { error: !j.ok });
  if (j.ok && batch === lastBatch) lastBatch = null;
  await refresh();
}

// ------------------------------------------------------------------------------------------ loading parts of the page

let loading = 0;

/**
 * Show another folder or list (push = a new history entry), or the same one again after a change
 * (keep = keep the selection and the place in the list).
 */
async function load(href: string, push: boolean, keep = false) {
  const token = ++loading;
  const focusAt = keep ? selectables().indexOf(document.activeElement as HTMLElement) : -1;
  const kept = keep ? selectedKeys() : [];
  const scroll = $('#desk-content')?.scrollTop ?? 0;
  const sideScroll = $('#desk-side')?.scrollTop ?? 0;
  const r = await fetch(href, { headers: { accept: 'text/html' } }).catch(() => null);
  if (token !== loading) return;
  if (!r || !r.ok) {
    location.href = href;
    return;
  }
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const fresh = doc.querySelector('#desk');
  if (!fresh) {
    location.href = href;
    return;
  }
  if (push) history.pushState(null, '', href);
  const desk = $('#desk')!;
  for (const [k, v] of Object.entries((fresh as HTMLElement).dataset)) desk.dataset[k] = v ?? '';
  for (const sel of ['#desk-top', '#desk-content', '#desk-bar', '#desk-inspector', '.desk-side .fixed', '.desk-side .quick', '.desk-side .smart', '.desk-side .folders']) {
    const next = doc.querySelector(sel);
    const here = $(sel);
    if (next && here) here.replaceWith(document.importNode(next, true));
  }
  $('#desk-data')!.textContent = doc.querySelector('#desk-data')?.textContent ?? '{}';
  const picker = doc.querySelector('#place-picker [data-options]');
  if (picker) $('#place-picker [data-options]')!.textContent = picker.textContent;
  resetPickerOptions();
  readData();
  afterSwap();
  if (keep) {
    $('#desk-content')!.scrollTop = scroll;
    $('#desk-side')!.scrollTop = sideScroll;
    const list = selectables();
    const again = list.filter((el) => kept.includes(keyOf(el)));
    for (const el of again) mark(el, true);
    if (again.length === 0 && focusAt >= 0 && list.length) {
      const el = list[Math.min(focusAt, list.length - 1)];
      mark(el, true);
      focus(el);
    }
    selectionChanged();
  } else {
    $('#desk-content')?.focus({ preventScroll: true });
  }
  syncSource();
}

const refresh = (keep = false) => load(location.pathname + location.search, false, keep);

/** What every freshly shown part needs. */
function afterSwap() {
  baseInspector = $('#desk-inspector')?.innerHTML ?? '';
  initPreviews($('#desk-inspector')!);
  initTextPreviews($('#desk-content')!);
  markPanes();
  applyLayout();
  applyTree();
  anchor = null;
  selectionChanged(true);
}

function navigate(href: string) {
  closeMenu();
  load(href, true);
}

// ------------------------------------------------------------------------------------------ layout, tree, source

const layoutKey = () => `rigel.view.${data.loc || data.view}`;

function applyLayout() {
  const desk = $('#desk')!;
  desk.dataset.layout = store.get(layoutKey(), data.layout);
  for (const b of $$<HTMLButtonElement>('[data-act="layout"]')) b.setAttribute('aria-pressed', String(b.dataset.layout === desk.dataset.layout));
}

// The side panes: hidden with [ and ] (or the buttons at the ends of the top bar), resized by dragging the
// gap next to them. The choices live on <html> (layouts/Admin.astro applies them before the page is drawn).
type Pane = 'side' | 'insp';
const PANES: Record<Pane, { attr: 'deskSide' | 'deskInsp'; key: string; width: string; prop: string; el: string }> = {
  side: { attr: 'deskSide', key: 'rigel.deskSide', width: 'rigel.deskSideW', prop: '--desk-side-w', el: '#desk-side' },
  insp: { attr: 'deskInsp', key: 'rigel.deskInsp', width: 'rigel.deskInspW', prop: '--desk-insp-w', el: '#desk-inspector' },
};
const paneShown = (p: Pane) => document.documentElement.dataset[PANES[p].attr] !== 'off';

function markPanes() {
  for (const p of ['side', 'insp'] as const) {
    for (const b of $$(`[data-act="toggle-${p}"]`)) b.setAttribute('aria-pressed', String(paneShown(p)));
  }
}

function togglePane(p: Pane, show = !paneShown(p)) {
  const { attr, key } = PANES[p];
  if (show) delete document.documentElement.dataset[attr];
  else document.documentElement.dataset[attr] = 'off';
  try {
    if (show) localStorage.removeItem(key);
    else localStorage.setItem(key, 'off');
  } catch {
    // private mode: the choice lasts for this page only
  }
  markPanes();
}

function initResize() {
  for (const handle of $$('.desk-resize')) {
    const pane = PANES[handle.dataset.resize as Pane];
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const from = ev.clientX;
      const start = $(pane.el)!.getBoundingClientRect().width;
      const sign = pane === PANES.side ? 1 : -1;
      let width = start;
      handle.setPointerCapture(ev.pointerId);
      handle.classList.add('active');
      document.body.classList.add('resizing');
      const move = (e: PointerEvent) => {
        width = Math.round(Math.max(160, Math.min(900, start + sign * (e.clientX - from))));
        document.documentElement.style.setProperty(pane.prop, `${width}px`);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
        try {
          localStorage.setItem(pane.width, String(width));
        } catch {
          // private mode
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('dblclick', () => {
      document.documentElement.style.removeProperty(pane.prop);
      try {
        localStorage.removeItem(pane.width);
      } catch {
        // private mode
      }
    });
  }
}

const TREE = 'rigel.treeOpen';

function applyTree() {
  const openIds = new Set(store.get<string[]>(TREE, []));
  for (const li of $$('.desk-side .folders li.fnode')) {
    if (openIds.has(li.dataset.id!)) li.classList.add('open');
    li.setAttribute('aria-expanded', String(li.classList.contains('open')));
  }
  $('.desk-side .frow.current')?.scrollIntoView({ block: 'nearest' });
}

function toggleNode(li: HTMLElement, open = !li.classList.contains('open')) {
  li.classList.toggle('open', open);
  li.setAttribute('aria-expanded', String(open));
  const ids = new Set(store.get<string[]>(TREE, []));
  if (open) ids.add(li.dataset.id!);
  else ids.delete(li.dataset.id!);
  store.set(TREE, [...ids].slice(-500));
}

function revealInTree(id: string) {
  for (const a of ancestorsOf(folders.get(id)?.parent ?? null)) {
    const li = $(`.desk-side .folders li.fnode[data-id="${a.id}"]`);
    if (li) toggleNode(li, true);
  }
  return $(`.desk-side .folders .frow[data-folder="${id}"]`);
}

let sourceFor: string | null = null;

/** 按来源浏览 is loaded when opened (it lists every original folder). */
async function syncSource() {
  const box = $<HTMLDetailsElement>('details[data-source]');
  if (!box?.open) return;
  const dir = data.dir;
  if (sourceFor === dir && $('[data-source-body] ul')) {
    for (const a of $$('[data-source-body] a')) a.classList.toggle('current', (a.dataset.dir ?? '') === dir && !!dir);
    return;
  }
  sourceFor = dir;
  const r = await fetch(`/admin/desk/source?dir=${encodeURIComponent(dir)}`);
  if (r.ok) $('[data-source-body]')!.innerHTML = await r.text();
}

// ------------------------------------------------------------------------------------------ selection

const selectables = () => $$('#desk-content .item, #desk-content .tile[data-folder]');
const keyOf = (el: HTMLElement) => (el.dataset.id ? `f:${el.dataset.id}` : `d:${el.dataset.folder}`);
const selectedEls = () => selectables().filter((el) => el.classList.contains('selected'));
const selectedKeys = () => selectedEls().map(keyOf);
const selectedFiles = () => selectedEls().filter((el) => el.dataset.id).map((el) => el.dataset.id!);
const selectedFolders = () => selectedEls().filter((el) => el.dataset.folder && !el.dataset.id).map((el) => el.dataset.folder!);

function mark(el: HTMLElement, on: boolean) {
  el.classList.toggle('selected', on);
  el.setAttribute('aria-selected', String(on));
  const box = el.querySelector<HTMLInputElement>('input.pick');
  if (box) box.checked = on;
}

/** The items under a group heading (up to the next heading). */
function groupItems(box: HTMLInputElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  let el = box.closest('.group')?.nextElementSibling as HTMLElement | null;
  while (el && el.classList.contains('item')) {
    items.push(el);
    el = el.nextElementSibling as HTMLElement | null;
  }
  return items;
}

function focus(el: HTMLElement | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

function selectOnly(el: HTMLElement) {
  for (const x of selectedEls()) if (x !== el) mark(x, false);
  mark(el, true);
  anchor = el;
  focus(el);
  selectionChanged();
}

function selectRange(el: HTMLElement, add: boolean) {
  const list = selectables();
  const a = list.indexOf(anchor ?? el);
  const b = list.indexOf(el);
  const [from, to] = a < b ? [a, b] : [b, a];
  list.forEach((x, i) => {
    if (i >= from && i <= to) mark(x, true);
    else if (!add) mark(x, false);
  });
  focus(el);
  selectionChanged();
}

function clearSelection() {
  for (const x of selectedEls()) mark(x, false);
  const all = $<HTMLInputElement>('[data-scope-all]');
  if (all) all.checked = false;
  selectionChanged();
}

let inspectTimer: ReturnType<typeof setTimeout> | undefined;
let inspectToken = 0;

/** The selection bar and, a moment later, the inspector follow the selection. */
function selectionChanged(immediate = false) {
  const files = selectedFiles();
  const fds = selectedFolders();
  const n = files.length + fds.length;
  // Group boxes follow their items (ticked when all are selected, dashed when some are); 「全部」
  // goes off once an item on the page is left out, so an action no longer reaches files deselected here.
  for (const box of $$<HTMLInputElement>('#desk-content input.pick-group')) {
    const items = groupItems(box);
    const on = items.filter((el) => el.classList.contains('selected')).length;
    box.checked = on > 0 && on === items.length;
    box.indeterminate = on > 0 && on < items.length;
  }
  const all = $<HTMLInputElement>('[data-scope-all]');
  if (all?.checked && $$('#desk-content .item:not(.selected)').length) all.checked = false;
  $('#desk')?.classList.toggle('has-selection', n > 0);
  const bar = $('#desk-bar');
  if (bar) {
    bar.hidden = n === 0;
    const count = bar.querySelector<HTMLElement>('[data-count]');
    if (count) count.textContent = String(n);
  }
  clearTimeout(inspectTimer);
  const run = () => inspect(files, fds);
  if (immediate) return;
  inspectTimer = setTimeout(run, n > 1 ? 250 : 120);
}

async function inspect(files: string[], fds: string[]) {
  const box = $('#desk-inspector')!;
  const token = ++inspectToken;
  if (files.length + fds.length === 0) {
    box.innerHTML = baseInspector;
    initPreviews(box);
    return;
  }
  const r = files.length === 1 && fds.length === 0
    ? await fetch(`/admin/desk/inspect?file=${files[0]}`)
    : fds.length === 1 && files.length === 0
      ? await fetch(`/admin/desk/inspect?folder=${fds[0]}&selected=1`)
      : await fetch('/admin/desk/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files, folders: fds }) });
  if (token !== inspectToken) return;
  box.innerHTML = r.ok ? await r.text() : `<p class="muted">${t('读取失败（HTTP {status}）', { status: r.status })}</p>`;
  initPreviews(box);
}

// ------------------------------------------------------------------------------------------ doing things

/** Files and folders an action is about: the given ones, else the selection. */
function targets(el?: HTMLElement | null): { files: string[]; folders: string[] } {
  const files = el?.dataset.files ? el.dataset.files.split(',') : null;
  const fds = el?.dataset.folders ? el.dataset.folders.split(',') : null;
  if (files || fds) return { files: files ?? [], folders: fds ?? [] };
  return { files: selectedFiles(), folders: selectedFolders() };
}

/** Move files and folders to a place (a folder key, or «top» for folders). */
async function moveTo(what: { files: string[]; folders: string[] }, key: string, newFolder = '') {
  if (what.folders.length) {
    const ok = await folderOp({ op: 'move', ids: what.folders, under: newFolder ? await ensureFolderKey(key, newFolder) : key });
    if (!ok) return;
  }
  if (what.files.length || $<HTMLInputElement>('[data-scope-all]')?.checked) {
    await fileAction('move', what.files, { target: key, new_folder: newFolder, keep: '__none__' });
  }
  if (key !== 'top') rememberPlace(key);
}

/** A folder made on the way (the picker's 「新建文件夹」 when moving folders). */
async function ensureFolderKey(under: string, name: string): Promise<string> {
  const r = await postJson('/admin/desk/folder', { op: 'create', under, name });
  return r.ok && r.id ? folderKey(String(r.id)) : under;
}

async function pickAndMove(what: { files: string[]; folders: string[] }) {
  if (!what.files.length && !what.folders.length && !$<HTMLInputElement>('[data-scope-all]')?.checked) {
    toast(t('先选中文件或文件夹'), { error: true });
    return;
  }
  const blocked = new Set(what.folders);
  const r = await openPicker({
    title: what.folders.length ? t('把 {n} 个文件夹和文件移到…', { n: what.folders.length }) : t('移动到…'),
    allowTop: what.files.length === 0,
    keepDir: what.files.length && data.dir ? data.dir : null,
    exclude: (key) => {
      if (key === 'top') return what.files.length > 0 && what.folders.length > 0;
      const id = key.slice(3);
      return [...blocked].some((f) => placeProblem(f, id) !== null);
    },
  });
  if (!r) return;
  if (r.keep && what.files.length) {
    await fileAction('move', what.files, { target: r.target, new_folder: r.newFolder, keep: data.dir });
    rememberPlace(r.target);
    return;
  }
  await moveTo(what, r.target, r.newFolder);
}

function freeName(parent: string | null, base: string): string {
  const taken = new Set((kids.get(parent) ?? []).map((k) => folders.get(k)!).filter((f) => f.kind === 'plain').map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
}

async function newFolder(under: string) {
  const parent = under === 'top' ? null : under.slice(3);
  const name = freeName(parent, t('新建文件夹'));
  await folderOp({ op: 'create', under, name }, {
    quiet: true,
    after: (r) => startRename(String(r.id)),
  });
}

/** Rename in place: the folder's row in the tree (or its tile); Enter saves, Esc cancels. */
function startRename(id: string) {
  const f = folders.get(id);
  if (!f) return;
  const tile = $(`#desk-content .tile[data-folder="${id}"] .tname`);
  if (!tile && !paneShown('side')) togglePane('side', true);
  const row = tile ? null : revealInTree(id)?.querySelector<HTMLElement>('.fname');
  const target = tile ?? row;
  if (!target) return;
  // A release is renamed by its title (without the catalog number), an edition by its name (without the source).
  let value = f.name;
  if (f.kind === 'release') value = f.name.replace(/^[A-Za-z]{2,}[A-Za-z0-9]*-\d+[A-Za-z]?\s+/, '');
  if (f.kind === 'edition') value = f.name.includes(' · ') ? f.name.split(' · ').slice(1).join(' · ') : '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = value;
  input.defaultValue = value;
  input.setAttribute('aria-label', f.kind === 'release' ? t('作品标题') : f.kind === 'edition' ? t('版本名称') : t('新名称'));
  const old = target.style.display;
  target.style.display = 'none';
  target.parentNode!.insertBefore(input, target.nextSibling);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    target.style.display = old;
    if (save && value !== input.defaultValue && (value || f.kind === 'edition')) await folderOp({ op: 'rename', id, name: value });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ------------------------------------------------------------------------------------------ renaming files

/** A file row's name, split into what can be changed and its extension (which stays). */
function fileName(el: HTMLElement): RenameFile {
  const name = el.dataset.name ?? '';
  const ext = el.dataset.ext ?? '';
  const tail = ext && name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name.slice(name.length - ext.length - 1) : '';
  return { id: el.dataset.id!, name, stem: tail ? name.slice(0, -tail.length) : name, ext: tail, orig: el.dataset.orig ?? name };
}

/**
 * Rename files ([id, new name] pairs; only these, whatever 「全部」 says). The server keeps the original
 * name and refuses clashes in a folder. Returns why it failed, or null.
 */
async function renameFiles(pairs: [string, string][]): Promise<string | null> {
  const body = new FormData();
  body.append('action', 'rename');
  for (const [id] of pairs) body.append('ids', id);
  body.append('names', JSON.stringify(pairs));
  const r = await fetch(`/admin/inbox${location.search}`, { method: 'POST', body, headers: { accept: 'application/json', 'x-admin-request': '1' } }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { ok: boolean; msg?: string; err?: string; batch?: string | null } | null;
  if (!j?.ok) return j?.err ?? t('操作失败');
  lastBatch = j.batch ?? lastBatch;
  toast(j.msg ?? '', { batch: j.batch ?? null });
  await refresh(true);
  return null;
}

/** Rename one file in its row: the name without the extension is edited; Enter saves, Esc cancels. */
function startFileRename(id: string) {
  const item = $(`#desk-content .item[data-id="${id}"]`);
  const target = item?.querySelector<HTMLElement>('.fn');
  if (!item || !target) return;
  const f = fileName(item);
  const box = document.createElement('span');
  box.className = 'rename-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = f.stem;
  input.defaultValue = f.stem;
  input.setAttribute('aria-label', t('新文件名'));
  const ext = document.createElement('span');
  ext.className = 'muted';
  ext.textContent = f.ext;
  box.appendChild(input);
  box.appendChild(ext);
  target.hidden = true;
  item.draggable = false;
  target.parentNode!.insertBefore(box, target.nextSibling);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    box.remove();
    target.hidden = false;
    item.draggable = true;
    focus(item);
    if (!save || !value || value === f.stem) return;
    const problem = await renameFiles([[id, value + f.ext]]);
    if (problem) toast(problem, { error: true });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/** 「批量重命名」: replace text, a template with numbers, or back to the original names. */
async function batchRename(ids: string[]) {
  const list = ids.map((id) => $(`#desk-content .item[data-id="${id}"]`)).filter((el): el is HTMLElement => !!el).map(fileName);
  if (!list.length) return;
  await renameBox(list, renameFiles);
}

/** F2: one file in place, several files in the dialog, else the folder. */
function renameSelection() {
  const files = selectedFiles();
  const fds = selectedFolders();
  if (files.length === 1 && !fds.length) startFileRename(files[0]);
  else if (files.length > 1 && !fds.length) batchRename(files);
  else {
    const id = fds[0] ?? currentFolder();
    if (id) startRename(id);
  }
}

// ------------------------------------------------------------------------------------------ tags and covers

/** 「标签与封面」 of one audio file (what its 整理版 download gets). */
async function editTags(id: string) {
  const r = await tagDialog(id);
  if (!r) return;
  if (!r.ok) {
    toast(r.err ?? t('读取失败'), { error: true });
    return;
  }
  lastBatch = r.batch ?? lastBatch;
  toast(r.msg ?? '', { batch: r.batch ?? null });
  await refresh(true);
}

/** 「设为封面」: a picture, or the cover an audio file carries, becomes the cover of every track of its edition. */
async function makeCover(id: string) {
  const r = await postJson('/admin/desk/tags', { op: 'cover', file: id });
  if (!r.ok) {
    toast(String(r.err ?? t('操作失败')), { error: true });
    return;
  }
  lastBatch = (r.batch as string | null) ?? lastBatch;
  toast(String(r.msg ?? ''), { batch: r.batch as string | null });
  await refresh(true);
}

/** 「合并到…」: this folder's contents go into the chosen folder, then this folder is removed. */
async function mergeInto(id: string) {
  const f = folders.get(id);
  if (!f) return;
  const r = await openPicker({
    title: t('把「{name}」合并到…', { name: f.name }),
    confirm: t('合并到这里'),
    go: true,
    exclude: (key) => key === 'top' || key === folderKey(id) || ancestorsOf(key.slice(3)).some((a) => a.id === id),
  });
  if (!r) return;
  if (await confirmBox(t('把「{from}」里的文件和文件夹并入「{to}」，然后删除「{from}」？同名的文件夹也会合并。', { from: f.path, to: nameOf(r.target.slice(3)) }), t('合并'))) {
    await folderOp({ op: 'merge', id, into: r.target });
  }
}

async function setType(id: string) {
  const f = folders.get(id);
  if (!f) return;
  if (f.kind !== 'plain') {
    const what = f.kind === 'release' ? t('作品') : f.kind === 'edition' ? t('版本') : t('名义');
    if (await confirmBox(t('把「{name}」改回普通文件夹？{what}的资料会删除（可在修改记录里撤销），文件和名字保留。', { name: f.name, what }), t('改回普通文件夹'))) {
      await folderOp({ op: 'type', id, type: 'plain' });
    }
    return;
  }
  const typedBelow = below(id).some((x) => x.kind !== 'plain');
  const ctx = contextOf(f.parent);
  const parentKind = f.parent ? folders.get(f.parent)?.kind : null;
  const why = {
    era: typedBelow ? t('里面有作品或版本') : f.parent ? t('只能在最顶层') : '',
    release: typedBelow ? t('里面有作品或版本') : !ctx.era ? t('要在某个名义里') : ctx.release ? t('不能在作品或版本里') : '',
    edition: typedBelow ? t('里面有作品或版本') : parentKind !== 'release' ? t('要在作品的下一层') : '',
  };
  const choice = await typeBox(f.name, why, data.guess[id] ?? { catalog_no: null, title: f.name });
  if (choice) await folderOp({ op: 'type', id, type: choice.type, options: choice.options });
}

async function deleteSelection(what: { files: string[]; folders: string[] }) {
  if (what.folders.length) await folderOp({ op: 'delete', ids: what.folders });
  if (what.files.length || $<HTMLInputElement>('[data-scope-all]')?.checked) await fileAction('discard', what.files);
}

async function paste() {
  if (!clipboard) {
    toast(t('没有剪切的内容'), { error: true });
    return;
  }
  const here = data.loc || null;
  if (!here) {
    toast(t('先打开要放入的文件夹'), { error: true });
    return;
  }
  const what = clipboard;
  clipboard = null;
  $$('.cut').forEach((e) => e.classList.remove('cut'));
  await moveTo(what, here);
}

function cut(what: { files: string[]; folders: string[] }) {
  if (!what.files.length && !what.folders.length) return;
  clipboard = what;
  $$('.cut').forEach((e) => e.classList.remove('cut'));
  for (const el of selectedEls()) el.classList.add('cut');
  toast(t('已剪切 {n} 个，打开目标文件夹后按 Ctrl+V 放入', { n: what.files.length + what.folders.length }));
}

/** Move a folder up or down among the folders next to it (a manual order from then on). */
async function shift(id: string, by: -1 | 1) {
  const f = folders.get(id);
  if (!f) return;
  const siblings = [...$$(f.parent ? `.desk-side li.fnode[data-id="${f.parent}"] > ul > li.fnode` : '.desk-side .folders > ul.ftree > li.fnode')].map((li) => li.dataset.id!);
  const at = siblings.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= siblings.length) return;
  [siblings[at], siblings[to]] = [siblings[to], siblings[at]];
  await folderOp({ op: 'reorder', under: f.parent ? folderKey(f.parent) : 'top', order: siblings }, { quiet: true });
}

async function reorderNear(id: string, near: string, after: boolean) {
  const f = folders.get(id);
  if (!f) return;
  const siblings = [...$$(f.parent ? `.desk-side li.fnode[data-id="${f.parent}"] > ul > li.fnode` : '.desk-side .folders > ul.ftree > li.fnode')].map((li) => li.dataset.id!).filter((x) => x !== id);
  const at = siblings.indexOf(near);
  if (at < 0) return;
  siblings.splice(after ? at + 1 : at, 0, id);
  await folderOp({ op: 'reorder', under: f.parent ? folderKey(f.parent) : 'top', order: siblings }, { quiet: true });
}

function editSmart(id: string | null) {
  const current = id ? data.smart.find((s) => s.id === id) ?? null : null;
  smartBox({ ...data, folders: data.folders.map((f) => ({ id: f.id, path: f.path })) }, current, async (name, rules) => {
    const r = await postJson('/admin/desk/smart', { op: 'save', id, name, rules });
    if (!r.ok) return String(r.err ?? t('保存失败'));
    toast(String(r.msg ?? ''));
    await load(`/admin/inbox?view=sf:${r.id}`, true);
    return null;
  });
}

// ------------------------------------------------------------------------------------------ the right-click menu

const recent = () => recentPlaces().filter((k) => !k.startsWith('fd:') || folders.has(k.slice(3)));
const placeName = (key: string) => (key.startsWith('fd:') ? nameOf(key.slice(3)) : key);

function fileMenu(): MenuEntry[] {
  const els = selectedEls().filter((el) => el.dataset.id);
  const what = targets();
  const one = els.length === 1 ? els[0] : null;
  const any = (attr: string) => els.some((el) => el.dataset[attr]);
  const places = recent();
  const head: MenuEntry[] = [];
  if (one) {
    const id = one.dataset.id!;
    head.push(
      { label: t('预览'), keys: t('空格'), run: () => previewBox(id, initPreviews) },
      { label: t('打开文件页'), keys: 'Enter', run: () => (location.href = `/admin/files/${id}`) },
      { label: t('重命名'), keys: 'F2', run: () => startFileRename(id) },
    );
    if (one.dataset.kind === 'audio') head.push({ label: t('编辑标签与封面…'), keys: 'E', run: () => editTags(id) });
    if (one.dataset.kind === 'image' || one.dataset.kind === 'audio') {
      head.push({
        label: one.dataset.kind === 'audio' ? t('用它自带的封面作本版封面') : t('设为封面'), run: () => makeCover(id),
        disabled: one.dataset.edition ? false : t('先把文件放进某个版本'),
      });
    }
    head.push('-');
  } else if (els.length > 1) head.push({ label: t('批量重命名…'), keys: 'F2', run: () => batchRename(els.map((el) => el.dataset.id!)) }, '-');
  return [
    ...head,
    { label: t('移动到…'), keys: 'M', run: () => pickAndMove(what) },
    ...places.slice(0, 5).map((k, i) => ({ label: t('放到「{place}」', { place: placeName(k) }), keys: i === 0 ? `Shift+D · ${i + 1}` : String(i + 1), run: () => moveTo(what, k) })),
    { label: t('按建议归档'), keys: 'A', run: () => fileAction('accept', what.files), disabled: any('sug') ? false : t('选中的文件没有规则建议') },
    { label: t('退回未归档'), run: () => fileAction('reset', what.files), disabled: any('placed') || any('state') ? false : t('没有已归档的文件') },
    { label: t('剪切'), keys: 'Ctrl+X', run: () => cut(what) },
    '-',
    { label: t('设为社团自有'), run: () => fileAction('rights', what.files, { rights_value: 'own' }) },
    { label: t('设为第三方'), keys: 'T', run: () => fileAction('rights', what.files, { rights_value: 'third_party' }) },
    { label: t('设为已授权'), run: () => fileAction('rights', what.files, { rights_value: 'licensed' }) },
    { label: t('权利改回未知'), run: () => fileAction('rights', what.files, { rights_value: 'unknown' }) },
    '-',
    { label: t('标为重复'), keys: 'D', run: () => fileAction('dup', what.files) },
    ...(any('archive') ? [{ label: t('整体收藏（压缩包）'), run: () => fileAction('seal', what.files) }] : []),
    ...(any('sealed') ? [{ label: t('展开整体收藏的包'), run: () => fileAction('unseal', what.files) }] : []),
    { label: t('忽略'), keys: 'I', run: () => fileAction('ignore', what.files) },
    { label: any('upload') ? t('删除（移到回收站）或忽略') : t('删除或忽略'), keys: 'Delete', danger: true, run: () => deleteSelection(what) },
  ];
}

function folderMenu(id: string, inTree: boolean): MenuEntry[] {
  const f = folders.get(id);
  if (!f) return [];
  const key = folderKey(id);
  const pinned = data.quick.includes(id);
  const what = inTree ? { files: [], folders: [id] } : targets();
  const many = what.folders.length > 1 || what.files.length > 0;
  const colors = ['', 'red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink'];
  const colorLabel: Record<string, string> = { '': t('无'), red: t('红'), orange: t('橙'), yellow: t('黄'), green: t('绿'), aqua: t('青'), blue: t('蓝'), purple: t('紫'), pink: t('粉') };
  return [
    { label: t('打开'), keys: 'Enter', run: () => navigate(`/admin/inbox?loc=${key}`) },
    { label: t('打开并显示子文件夹内容'), run: () => navigate(`/admin/inbox?loc=${key}&sub=1`) },
    '-',
    { label: t('新建子文件夹'), keys: 'Ctrl+Shift+N', run: () => newFolder(key) },
    { label: t('批量新建子文件夹…'), run: async () => { const text = await batchBox(f.path); if (text) await folderOp({ op: 'create_many', under: key, text }); } },
    { label: t('重命名'), keys: 'F2', run: () => startRename(id), disabled: many ? t('一次只能重命名一个') : false },
    { label: t('移动到…'), run: () => pickAndMove(what), disabled: f.kind === 'era' ? t('名义只能放在最顶层') : f.extras ? t('附件文件夹不能移出所在的版本') : false },
    { label: t('合并到…'), run: () => mergeInto(id), disabled: f.kind !== 'plain' ? t('只有普通文件夹可以合并到别的文件夹') : f.extras ? t('附件文件夹不能移出所在的版本') : many ? t('一次合并一个') : false },
    { label: t('剪切'), keys: 'Ctrl+X', run: () => cut(what), disabled: f.extras ? t('附件文件夹不能移出所在的版本') : false },
    ...(clipboard ? [{ label: t('粘贴到这里'), keys: 'Ctrl+V', run: async () => { const c = clipboard!; clipboard = null; await moveTo(c, key); } }] : []),
    { label: t('上移'), keys: 'Ctrl+[', run: () => shift(id, -1) },
    { label: t('下移'), keys: 'Ctrl+]', run: () => shift(id, 1) },
    { label: t('子文件夹按默认顺序排列'), run: () => folderOp({ op: 'reorder', under: key, order: null }, { quiet: true }) },
    '-',
    { label: f.kind === 'plain' ? t('设为名义、作品或版本…') : t('改回普通文件夹…'), run: () => setType(id), disabled: f.extras ? t('附件文件夹不能设为其他类型') : false },
    { label: t('颜色'), swatches: colors.map((c) => ({ color: c, label: colorLabel[c], on: false, run: () => folderOp({ op: 'color', id, color: c }, { quiet: true }) })) },
    { label: pinned ? t('移出快速访问') : t('加入快速访问'), run: () => folderOp({ op: pinned ? 'unpin' : 'pin', id }, { quiet: true }) },
    ...(f.release ? [{ label: t('打开作品页'), run: () => (location.href = `/admin/releases/${f.release}`) }] : []),
    ...(f.edition ? [{ label: t('打开版本页'), run: () => (location.href = `/admin/editions/${f.edition}`) }] : []),
    '-',
    { label: t('删除'), keys: 'Delete', danger: true, run: () => deleteSelection(inTree ? { files: [], folders: [id] } : what), disabled: f.extras ? t('附件文件夹随版本一起删除') : false },
  ];
}


function backgroundMenu(): MenuEntry[] {
  const here = data.loc;
  return [
    ...(here ? [
      { label: t('新建文件夹'), keys: 'Ctrl+Shift+N', run: () => newFolder(here) },
      { label: t('批量新建文件夹…'), run: async () => { const text = await batchBox(nameOf(here.slice(3))); if (text) await folderOp({ op: 'create_many', under: here, text }); } },
      ...(clipboard ? [{ label: t('粘贴'), keys: 'Ctrl+V', run: paste }] : []),
      '-' as const,
    ] : []),
    { label: t('全选'), keys: 'Ctrl+A', run: selectAll },
    { label: t('列表'), run: () => setLayout('list') },
    { label: t('网格'), run: () => setLayout('grid') },
    ...(here ? [{ label: data.sub ? t('只显示这一层的文件') : t('显示子文件夹内容'), run: () => toggleSub() }] : []),
  ];
}

function openFolderMenuFor(id: string, x: number, y: number, inTree: boolean) {
  openMenu(folderMenu(id, inTree), x, y);
}

// ------------------------------------------------------------------------------------------ small actions

function selectAll() {
  for (const el of selectables()) mark(el, true);
  selectionChanged();
}

function setLayout(layout: string) {
  store.set(layoutKey(), layout);
  applyLayout();
}

function toggleSub() {
  const u = new URL(location.href);
  if (data.sub) u.searchParams.delete('sub');
  else u.searchParams.set('sub', '1');
  u.searchParams.delete('page');
  navigate(u.pathname + u.search);
}

function parentHref(): string | null {
  const id = currentFolder();
  if (!id) return data.dir ? (() => {
    const u = new URL(location.href);
    const up = data.dir.split('/').slice(0, -1).join('/');
    if (up) u.searchParams.set('dir', up);
    else u.searchParams.delete('dir');
    return u.pathname + u.search;
  })() : null;
  const parent = folders.get(id)?.parent;
  return parent ? `/admin/inbox?loc=${folderKey(parent)}` : '/admin/inbox?view=all';
}

function open(el: HTMLElement) {
  if (el.dataset.folder && !el.dataset.id) navigate(`/admin/inbox?loc=${folderKey(el.dataset.folder)}`);
  else if (el.dataset.id) location.href = `/admin/files/${el.dataset.id}`;
}

// ------------------------------------------------------------------------------------------ drag and drop

let dragging: { files: string[]; folders: string[]; fromQuick?: boolean } | null = null;

function dropTarget(el: HTMLElement): { key?: string; special?: string; folder?: string } | null {
  const d = el.dataset.drop;
  if (d === 'folder' && el.dataset.folder) return { key: folderKey(el.dataset.folder), folder: el.dataset.folder };
  if (d === 'top') return { key: 'top' };
  if (d) return { special: d };
  return null;
}

/** What dropping here would do, or why it cannot be done. */
function dropPlan(el: HTMLElement, ev: DragEvent): { text: string; ok: boolean; run: () => Promise<unknown> } | null {
  if (!dragging) return null;
  const what = dragging;
  const target = dropTarget(el);
  if (!target) return null;
  const n = what.files.length + what.folders.length;
  // A 快速访问 entry dropped on another one: the list's order, not a move.
  if (what.fromQuick && el.dataset.quick !== undefined && target.folder && target.folder !== what.folders[0]) {
    const order = data.quick.filter((q) => q !== what.folders[0]);
    const r = el.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    order.splice(order.indexOf(target.folder) + (after ? 1 : 0), 0, what.folders[0]);
    el.classList.toggle('drop-before', !after);
    el.classList.toggle('drop-after', after);
    return { text: t('调整快速访问的顺序'), ok: true, run: () => folderOp({ op: 'quick_order', order }, { quiet: true }) };
  }
  if (target.special) {
    if (target.special === 'quick') {
      if (what.files.length || !what.folders.length) return { text: t('只能把文件夹拖到快速访问'), ok: false, run: async () => {} };
      return { text: t('加入快速访问'), ok: true, run: async () => { for (const id of what.folders) await folderOp({ op: 'pin', id }, { quiet: true }); } };
    }
    if (what.folders.length) return { text: t('这里只能放文件'), ok: false, run: async () => {} };
    if (target.special === 'unplaced') return { text: t('退回未归档（{n} 个）', { n }), ok: true, run: () => fileAction('reset', what.files) };
    if (target.special === 'ignored') return { text: t('忽略（{n} 个）', { n }), ok: true, run: () => fileAction('ignore', what.files) };
    if (target.special === 'trash') return { text: t('删除或忽略（{n} 个）', { n }), ok: true, run: () => fileAction('discard', what.files) };
    return null;
  }
  const into = target.folder ?? null;
  // A folder dropped near the edge of a folder next to it: put it before or after that one.
  if (what.folders.length === 1 && !what.files.length && into && into !== what.folders[0]) {
    const moving = folders.get(what.folders[0]);
    const near = folders.get(into);
    if (moving && near && moving.parent === near.parent) {
      const r = el.getBoundingClientRect();
      // Cards side by side: left or right edge; rows (the tree, the list): top or bottom edge.
      const across = el.classList.contains('tile') && $('#desk')!.dataset.layout === 'grid';
      const pos = across ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      if (pos < 0.25 || pos > 0.75) {
        const after = pos > 0.75;
        el.classList.toggle('drop-before', !after);
        el.classList.toggle('drop-after', after);
        return { text: after ? t('放在「{name}」后面', { name: near.name }) : t('放在「{name}」前面', { name: near.name }), ok: true, run: () => reorderNear(moving.id, near.id, after) };
      }
    }
  }
  el.classList.remove('drop-before', 'drop-after');
  for (const id of what.folders) {
    const problem = placeProblem(id, into);
    if (problem) return { text: problem, ok: false, run: async () => {} };
  }
  if (!into && what.files.length) return { text: t('文件要放进某个文件夹'), ok: false, run: async () => {} };
  if (into && what.folders.length === 0 && what.files.length && into === currentFolder() && !data.sub) return { text: t('已经在这个文件夹里'), ok: false, run: async () => {} };
  return { text: t('移到「{place}」（{n} 个）', { place: nameOf(into), n }), ok: true, run: () => moveTo(what, target.key!) };
}

function initDrag() {
  const label = $('#desk-drag')!;
  document.addEventListener('dragstart', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.item, .tile[data-folder], .frow[data-folder]');
    if (!el) return;
    const inContent = !!el.closest('#desk-content');
    if (inContent && !el.classList.contains('selected')) selectOnly(el);
    dragging = inContent ? { files: selectedFiles(), folders: selectedFolders() } : { files: [], folders: [el.dataset.folder!], fromQuick: el.dataset.quick !== undefined };
    ev.dataTransfer?.setData('text/plain', [...dragging.files, ...dragging.folders].join(','));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragend', () => {
    dragging = null;
    label.hidden = true;
    document.body.classList.remove('dragging');
    $$('.drop-over, .drop-no, .drop-before, .drop-after').forEach((e) => e.classList.remove('drop-over', 'drop-no', 'drop-before', 'drop-after'));
  });
  document.addEventListener('dragover', (ev) => {
    if (!dragging) return;
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    $$('.drop-over, .drop-no').forEach((e) => e !== el && e.classList.remove('drop-over', 'drop-no', 'drop-before', 'drop-after'));
    if (!el) {
      label.hidden = true;
      return;
    }
    const plan = dropPlan(el, ev);
    if (!plan) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = plan.ok ? 'move' : 'none';
    el.classList.toggle('drop-over', plan.ok);
    el.classList.toggle('drop-no', !plan.ok);
    label.textContent = plan.ok ? plan.text : `✕ ${plan.text}`;
    label.classList.toggle('no', !plan.ok);
    label.hidden = false;
    label.style.left = `${ev.clientX + 14}px`;
    label.style.top = `${ev.clientY + 14}px`;
  });
  document.addEventListener('drop', (ev) => {
    if (!dragging) return;
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (!el) return;
    ev.preventDefault();
    const plan = dropPlan(el, ev);
    label.hidden = true;
    if (plan?.ok) plan.run();
  });
}

// ------------------------------------------------------------------------------------------ box selection

let marqueed = false; // the click that ends a box selection does not clear it

function initMarquee() {
  let start: { x: number; y: number; add: boolean; before: Set<HTMLElement> } | null = null;
  let box: HTMLElement | null = null;
  document.addEventListener('mousedown', (ev) => {
    const content = $('#desk-content');
    const target = ev.target as HTMLElement;
    if (ev.button !== 0 || !content?.contains(target)) return;
    if (target.closest('.item, .tile, a, button, input, select, textarea, .readme, .pager, .trash-row, .items-head')) return;
    start = { x: ev.clientX, y: ev.clientY, add: ev.ctrlKey || ev.metaKey || ev.shiftKey, before: new Set(selectedEls()) };
    if (!start.add) clearSelection();
    ev.preventDefault();
    content.focus({ preventScroll: true });
  });
  document.addEventListener('mousemove', (ev) => {
    if (!start) return;
    if (!box) {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 6) return;
      box = document.createElement('div');
      box.className = 'marquee';
      document.body.appendChild(box);
    }
    const x1 = Math.min(start.x, ev.clientX);
    const y1 = Math.min(start.y, ev.clientY);
    const x2 = Math.max(start.x, ev.clientX);
    const y2 = Math.max(start.y, ev.clientY);
    Object.assign(box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    for (const el of selectables()) {
      const r = el.getBoundingClientRect();
      const hit = r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1;
      mark(el, hit || start.before.has(el));
    }
    selectionChanged();
  });
  document.addEventListener('mouseup', () => {
    marqueed = !!box;
    start = null;
    box?.remove();
    box = null;
  });
}

// ------------------------------------------------------------------------------------------ clicks

function initClicks() {
  document.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest('input.rename')) return; // typing a new name
    const act = target.closest<HTMLElement>('[data-act]');

    // The tree: the triangle opens and closes; a row opens its folder.
    const twisty = target.closest<HTMLElement>('.twisty');
    if (twisty) {
      ev.preventDefault();
      toggleNode(twisty.closest<HTMLElement>('li.fnode')!);
      return;
    }

    // Items and tiles: a click selects (Ctrl / Shift for several), the checkbox toggles.
    const item = target.closest<HTMLElement>('#desk-content .item, #desk-content .tile[data-folder]');
    if (item && !(act && act.dataset.act !== 'menu') && !target.closest('.place-link, .chips a')) {
      // A cancelled click puts a checkbox back the way it was after this handler, undoing mark().
      if (!target.closest('input.pick')) ev.preventDefault();
      if (act?.dataset.act === 'menu') {
        if (!item.classList.contains('selected')) selectOnly(item);
        const r = act.getBoundingClientRect();
        if (item.dataset.id) openMenu(fileMenu(), r.left, r.bottom);
        else openFolderMenuFor(item.dataset.folder!, r.left, r.bottom, false);
        return;
      }
      if (target.closest('input.pick') || ev.ctrlKey || ev.metaKey) {
        mark(item, !item.classList.contains('selected'));
        anchor = item;
        focus(item);
        selectionChanged();
      } else if (ev.shiftKey) selectRange(item, false);
      else selectOnly(item);
      return;
    }
    const group = target.closest<HTMLInputElement>('input.pick-group');
    if (group) {
      for (const el of groupItems(group)) mark(el, group.checked);
      selectionChanged();
      return;
    }

    // Links that stay on the 整理台 load in place.
    const link = target.closest<HTMLAnchorElement>('a[data-nav]');
    if (link && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.button === 0) {
      ev.preventDefault();
      navigate(link.getAttribute('href')!);
      return;
    }
    const row = target.closest<HTMLElement>('.frow[data-folder]');
    if (row && !act && !target.closest('a')) {
      navigate(`/admin/inbox?loc=${folderKey(row.dataset.folder!)}`);
      return;
    }
    if (!act) {
      if (marqueed) marqueed = false;
      else if (target.closest('#desk-content') && !target.closest('a, button, input, select, textarea, .readme')) clearSelection();
      return;
    }
    const a = act.dataset.act!;
    switch (a) {
      case 'menu-selection': {
        const r = act.getBoundingClientRect();
        if (selectedFiles().length) openMenu(fileMenu(), r.left, r.top - 8);
        else if (selectedFolders().length) openFolderMenuFor(selectedFolders()[0], r.left, r.top - 8, false);
        break;
      }
      case 'clear-selection': clearSelection(); break;
      case 'move-selection': pickAndMove(targets()); break;
      case 'move-files':
      case 'move-folders': pickAndMove(targets(act)); break;
      case 'file-action': {
        const what = targets(act);
        if (act.dataset.action === 'discard') deleteSelection(what);
        else fileAction(act.dataset.action!, what.files);
        break;
      }
      case 'rename': startRename(act.dataset.folder!); break;
      case 'rename-file': startFileRename(act.dataset.file!); break;
      case 'edit-tags': editTags(act.dataset.file!); break;
      case 'set-cover': makeCover(act.dataset.file!); break;
      case 'toggle-side': togglePane('side'); break;
      case 'toggle-insp': togglePane('insp'); break;
      case 'new-folder': newFolder(act.dataset.under || 'top'); break;
      case 'pin':
      case 'unpin': folderOp({ op: a, id: act.dataset.folder }, { quiet: true }); break;
      case 'delete-folders': deleteSelection({ files: [], folders: act.dataset.folders!.split(',') }); break;
      case 'set-type': setType(act.dataset.folder!); break;
      case 'color': folderOp({ op: 'color', id: act.dataset.folder, color: act.dataset.color ?? '' }, { quiet: true }); break;
      case 'open': navigate(`/admin/inbox?loc=${act.dataset.key}`); break;
      case 'undo': undo(act.dataset.batch!); break;
      case 'undo-toast': undo(act.dataset.batch || lastBatch); break;
      case 'close-toast': $('#desk-toast')!.hidden = true; break;
      case 'smart-new': editSmart(null); break;
      case 'smart-edit': editSmart(act.dataset.smart!); break;
      case 'smart-delete':
        if (await confirmBox(t('删除这个智能文件夹？文件不受影响。'), t('删除'))) {
          const r = await postJson('/admin/desk/smart', { op: 'delete', id: act.dataset.smart });
          toast(String(r.ok ? r.msg : r.err), { error: !r.ok });
          if (r.ok) navigate('/admin/inbox?view=all');
        }
        break;
      case 'expand-all': expandAll(); break;
      case 'help': helpBox(guideBox); break;
      case 'layout': setLayout(act.dataset.layout!); break;
      case 'sort-dir': {
        const u = new URL(location.href);
        if (act.dataset.desc === '1') u.searchParams.delete('desc');
        else u.searchParams.set('desc', '1');
        navigate(u.pathname + u.search);
        break;
      }
    }
  });

  document.addEventListener('dblclick', (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>('#desk-content .item, #desk-content .tile[data-folder]');
    if (item && !(ev.target as HTMLElement).closest('input, button')) open(item);
  });

  document.addEventListener('contextmenu', (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest('input, textarea, select, .readme pre, #desk-inspector, dialog')) return;
    const item = target.closest<HTMLElement>('#desk-content .item, #desk-content .tile[data-folder]');
    const row = target.closest<HTMLElement>('.desk-side .frow[data-folder]');
    const content = target.closest('#desk-content');
    if (!item && !row && !content) return;
    ev.preventDefault();
    if (item) {
      if (!item.classList.contains('selected')) selectOnly(item);
      if (item.dataset.id) openMenu(fileMenu(), ev.clientX, ev.clientY);
      else openFolderMenuFor(item.dataset.folder!, ev.clientX, ev.clientY, false);
    } else if (row) openFolderMenuFor(row.dataset.folder!, ev.clientX, ev.clientY, true);
    else openMenu(backgroundMenu(), ev.clientX, ev.clientY);
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.matches('select[data-act="rights"]')) {
      const v = (el as unknown as HTMLSelectElement).value;
      if (v) fileAction('rights', targets(el).files, { rights_value: v });
    } else if (el.matches('input[data-act="sub"]')) toggleSub();
    else if (el.matches('select[data-param]')) {
      const u = new URL(location.href);
      u.searchParams.set(el.dataset.param!, (el as unknown as HTMLSelectElement).value);
      u.searchParams.delete('page');
      navigate(u.pathname + u.search);
    } else if (el.matches('[data-scope-all]')) {
      if ((el as HTMLInputElement).checked) selectAll();
    }
  });

  document.addEventListener('submit', async (ev) => {
    const form = ev.target as HTMLFormElement;
    if (form.matches('[data-search]')) {
      ev.preventDefault();
      const params = new URLSearchParams(new FormData(form) as unknown as Record<string, string>);
      if (!params.get('q')) params.delete('q');
      navigate(`/admin/inbox?${params}`);
    } else if (form.dataset.op === 'info') {
      ev.preventDefault();
      const f = new FormData(form);
      folderOp({ op: 'info', id: form.dataset.folder, description: f.get('description'), readme_file_id: f.get('readme_file_id') });
    } else if (form.dataset.op === 'note') {
      ev.preventDefault();
      fileAction('note', [form.dataset.file!], { note: String(new FormData(form).get('note') ?? '') });
    }
  });

  $('details[data-source]')?.addEventListener('toggle', () => syncSource());
  addEventListener('popstate', () => load(location.pathname + location.search, false));
}

function expandAll() {
  const nodes = $$('.desk-side .folders li.fnode:not(.leaf)');
  const open = nodes.some((li) => !li.classList.contains('open'));
  for (const li of nodes) toggleNode(li, open);
}

// ------------------------------------------------------------------------------------------ keyboard

function initKeys() {
  document.addEventListener('keydown', async (ev) => {
    if (ev.defaultPrevented || document.querySelector('dialog[open]') || !$('#desk-menu')!.hidden) return;
    const target = ev.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) {
      if (ev.key === 'Escape') target.blur();
      return;
    }
    const ctrl = ev.ctrlKey || ev.metaKey;
    const key = ev.key;
    const list = selectables();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const grid = $('#desk')!.dataset.layout === 'grid';
    const step = (by: number) => {
      const next = list[Math.max(0, Math.min(list.length - 1, (at < 0 ? (by > 0 ? -1 : list.length) : at) + by))];
      if (!next) return;
      if (ev.shiftKey) {
        anchor ??= list[at] ?? next;
        selectRange(next, false);
      } else selectOnly(next);
    };
    const perRow = () => {
      if (!grid || list.length < 2) return 1;
      const top = list[0].getBoundingClientRect().top;
      const n = list.findIndex((el) => el.getBoundingClientRect().top > top + 4);
      return n > 0 ? n : list.length;
    };
    const what = () => targets();
    const one = () => (at >= 0 ? list[at] : selectedEls()[0]);

    if (key === 'ArrowDown' || (key === 'j' && !ctrl)) { ev.preventDefault(); step(grid && key === 'ArrowDown' ? perRow() : 1); }
    else if (key === 'ArrowUp' || (key === 'k' && !ctrl)) {
      if (ev.altKey) { const up = parentHref(); if (up) navigate(up); return; }
      ev.preventDefault(); step(grid && key === 'ArrowUp' ? -perRow() : -1);
    } else if (grid && key === 'ArrowRight') { ev.preventDefault(); step(1); }
    else if (grid && key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
    else if (key === 'Home') { ev.preventDefault(); if (list[0]) selectOnly(list[0]); }
    else if (key === 'End') { ev.preventDefault(); if (list.length) selectOnly(list[list.length - 1]); }
    else if (key === ' ') {
      const el = one();
      if (el?.dataset.id) { ev.preventDefault(); previewBox(el.dataset.id, initPreviews); }
    } else if (key === 'Enter') { const el = one(); if (el) { ev.preventDefault(); open(el); } }
    else if (key === 'Backspace') { const up = parentHref(); if (up) { ev.preventDefault(); navigate(up); } }
    else if (key === 'Escape') clearSelection();
    else if (ctrl && key.toLowerCase() === 'a') { ev.preventDefault(); selectAll(); }
    else if (ctrl && ev.shiftKey && key.toLowerCase() === 'n') { ev.preventDefault(); newFolder(data.loc || 'top'); }
    else if (ctrl && ev.shiftKey && key.toLowerCase() === 'j') { ev.preventDefault(); pickAndMove(what()); }
    else if (ctrl && key.toLowerCase() === 'j') {
      ev.preventDefault();
      const r = await openPicker({ title: t('跳转到文件夹'), confirm: t('打开'), go: true, exclude: (k) => k === 'top' });
      if (r) navigate(`/admin/inbox?loc=${r.target}`);
    } else if (ctrl && key.toLowerCase() === 'x') { ev.preventDefault(); cut(what()); }
    else if (ctrl && key.toLowerCase() === 'v') { ev.preventDefault(); paste(); }
    else if (ctrl && key.toLowerCase() === 'z') { ev.preventDefault(); undo(); }
    else if (ctrl && (key === '[' || key === ']')) {
      ev.preventDefault();
      const id = selectedFolders()[0] ?? currentFolder();
      if (id) shift(id, key === '[' ? -1 : 1);
    } else if (ctrl || ev.altKey) return;
    else if (key === 'F2') {
      ev.preventDefault();
      renameSelection();
    } else if (key === '[') togglePane('side');
    else if (key === ']') togglePane('insp');
    else if (key === 'e') {
      const el = selectedEls().length === 1 ? selectedEls()[0] : null;
      if (el?.dataset.kind === 'audio') editTags(el.dataset.id!);
    } else if (key === 'Delete') { ev.preventDefault(); deleteSelection(what()); }
    else if (key === '?') helpBox(guideBox);
    else if (key === '*') expandAll();
    else if (key === 'u') undo();
    else if (key === 'm') { ev.preventDefault(); pickAndMove(what()); }
    else if (key === 'D' && ev.shiftKey) { const k = recent()[0]; if (k) moveTo(what(), k); }
    else if (/^[1-5]$/.test(key)) { const k = recent()[Number(key) - 1]; if (k) moveTo(what(), k); }
    else if (key === 'a') fileAction('accept', what().files);
    else if (key === 'i') fileAction('ignore', what().files);
    else if (key === 't') fileAction('rights', what().files, { rights_value: 'third_party' });
    else if (key === 'd') fileAction('dup', what().files);
  });
}

// ------------------------------------------------------------------------------------------ start

export function initDesk() {
  if (!$('#desk')) return;
  // A thumbnail whose picture cannot be loaded (not in storage yet) shows the file type instead.
  document.addEventListener('error', (ev) => {
    const img = ev.target as HTMLElement;
    if (img.tagName !== 'IMG' || !img.closest('.thumb')) return;
    const span = document.createElement('span');
    span.className = 'kind-icon';
    span.textContent = (img.closest<HTMLElement>('.item')?.querySelector('.fn')?.textContent?.split('.').pop() ?? '?').slice(0, 4).toUpperCase();
    img.parentNode?.replaceChild(span, img);
  }, true);
  readData();
  afterSwap();
  initClicks();
  initKeys();
  initResize();
  initDrag();
  initMarquee();
  syncSource();
  if (!store.get('rigel.deskGuide', false)) setTimeout(guideBox, 400);
}
