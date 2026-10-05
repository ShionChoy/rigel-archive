// The edition page's 「文件」 (pages/admin/editions/[id].astro): the edition's files and folders as a small
// file manager. Tick rows (Shift for a range) or click them (Ctrl / Shift to add), then move, rename, ignore
// or delete them from the bar, the ⋯ button or the right-click menu, or drag them onto a folder. Every
// action is the 整理台's own (the same requests, one history entry each, 「撤销」 in the message); the
// section is fetched again afterwards, and the track list takes the new files when it has nothing unsaved.

import { t } from './i18n';
import { closeMenu, confirmBox, openMenu, renameBox, toast, type MenuEntry, type RenameFile } from './desk-ui';
import {
  fileRequest, folderRequest, moreQueued, nameNewFolder, postJson, queued, renameInPlace, renameRequest, report, undoRequest, type Reply,
} from './file-ops';
import { openPicker, rememberPlace, resetPickerOptions } from './place-picker';
import { namingProblem, renderName, type NameParts } from '../lib/naming';
import type { Editor } from './edition';

type Sel = { files: string[]; folders: string[] };

// The Workers types clash with the DOM's ParentNode here; these take any element.
const $ = <E extends Element = HTMLElement>(sel: string, root: unknown = document) => (root as ParentNode).querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: unknown = document) => [...(root as ParentNode).querySelectorAll<E>(sel)];
const editor = () => (window as unknown as { rigelEditor?: Editor }).rigelEditor;

const section = $('#files');
const selected = new Set<string>(); // row keys: f:<file id>, d:<folder id>
const closed = new Set<string>(); // folders shown closed (their triangle), kept when the list comes again
let anchor: string | null = null; // where a Shift range starts

const rows = () => $$<HTMLTableRowElement>('tr[data-key]', section!);
const rowOf = (key: string) => rows().find((r) => r.dataset.key === key) ?? null;
const idOf = (key: string) => key.slice(2);
const isFile = (key: string) => key.startsWith('f:');
const selectable = (r: HTMLElement) => r.dataset.role !== 'root';
const home = () => section?.dataset.home ?? '';
const folderKey = (id: string) => `fd:${id}`;

function current(): Sel {
  const keys = rows().map((r) => r.dataset.key!).filter((k) => selected.has(k));
  return { files: keys.filter(isFile).map(idOf), folders: keys.filter((k) => !isFile(k)).map(idOf) };
}

// ------------------------------------------------------------------------------------------ opening and closing folders

/** Rows inside a closed folder are hidden (and no longer selected). */
function applyClosed() {
  let cut = Infinity;
  for (const r of rows()) {
    const d = Number(r.dataset.depth || 0);
    if (d <= cut) cut = Infinity;
    const key = r.dataset.key!;
    const shut = !isFile(key) && closed.has(idOf(key));
    r.classList.toggle('closed', shut);
    r.querySelector('[data-twisty]')?.setAttribute('aria-expanded', String(!shut));
    r.hidden = cut !== Infinity;
    if (r.hidden) selected.delete(key);
    if (!r.hidden && shut) cut = d;
  }
}

function toggleFolder(key: string) {
  const id = idOf(key);
  if (closed.has(id)) closed.delete(id);
  else closed.add(id);
  applyClosed();
  paint();
}

// ------------------------------------------------------------------------------------------ selection

function paint() {
  for (const r of rows()) {
    const on = selected.has(r.dataset.key!);
    r.classList.toggle('selected', on);
    const box = $<HTMLInputElement>('input[data-sel]', r);
    if (box) box.checked = on;
  }
  const n = selected.size;
  const all = $<HTMLInputElement>('input[data-sel-all]', section!);
  const choosable = rows().filter((r) => selectable(r) && !r.hidden);
  if (all) {
    all.checked = n > 0 && n === choosable.length;
    all.indeterminate = n > 0 && n < choosable.length;
  }
  const bar = $('[data-files-bar]', section!);
  if (!bar) return;
  $('.files-bar-idle', bar)!.hidden = n > 0;
  $('.files-bar-sel', bar)!.hidden = n === 0;
  const count = $('[data-count]', bar);
  if (count) count.textContent = String(n);
  const sel = current();
  const rename = $<HTMLButtonElement>('[data-files-act="rename"]', bar)!;
  rename.disabled = !(sel.files.length > 0 && sel.folders.length === 0) && !(sel.files.length === 0 && sel.folders.length === 1 && rowOf(`d:${sel.folders[0]}`)?.dataset.role !== 'root');
  rename.textContent = sel.files.length > 1 ? t('批量重命名…') : t('重命名');
  $<HTMLButtonElement>('[data-files-act="ignore"]', bar)!.disabled = sel.files.length === 0;
  const fixed = sel.folders.some((id) => rowOf(`d:${id}`)?.dataset.role !== 'plain');
  $<HTMLButtonElement>('[data-files-act="delete"]', bar)!.disabled = fixed;
  $<HTMLButtonElement>('[data-files-act="move"]', bar)!.disabled = fixed;
}

function selectOnly(key: string) {
  selected.clear();
  selected.add(key);
  anchor = key;
  paint();
}

function toggle(key: string, range: boolean) {
  if (range && anchor) {
    const keys = rows().filter((r) => selectable(r) && !r.hidden).map((r) => r.dataset.key!);
    const a = keys.indexOf(anchor);
    const b = keys.indexOf(key);
    if (a >= 0 && b >= 0) {
      for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(k);
      paint();
      return;
    }
  }
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  anchor = key;
  paint();
}

function clearSelection() {
  selected.clear();
  anchor = null;
  paint();
}

// ------------------------------------------------------------------------------------------ talking to the server
// The 整理台's own requests and queue (scripts/file-ops.ts): one action at a time, a key pressed meanwhile waits.

/** A folder operation (/admin/desk/folder), its message shown; null when it failed or the admin said no. */
async function folderOp(body: Record<string, unknown>): Promise<Reply | null> {
  const r = await folderRequest(body);
  if (r) report(r);
  return r;
}

/** A file action (the 整理台's POST): move, ignore, discard, rights, dup, reset. */
async function fileAction(action: string, ids: string[], extra: Record<string, string> = {}): Promise<boolean> {
  if (!ids.length) return false;
  const r = await fileRequest(action, ids, extra);
  if (r) report(r);
  return !!r;
}

/** One action at a time (the list is dimmed meanwhile); the section and the track list are fetched again after the last. */
function run(work: () => Promise<unknown>, opts: { keep?: boolean } = {}) {
  return queued(async () => {
    section?.classList.add('working');
    try {
      closeMenu();
      await work();
      if (!opts.keep) clearSelection();
      if (!moreQueued()) await refresh();
    } finally {
      if (!moreQueued()) section?.classList.remove('working');
    }
  });
}

function undo(batch?: string | null) {
  return run(() => undoRequest(batch));
}

/**
 * Run another part of the page's change in this list's queue, then fetch the list and 公开站 again
 * (scripts/edition-access.ts): its message stays, and actions never overlap.
 */
export const withFilesRefresh = (work: () => Promise<unknown>) => run(work, { keep: true });

/** Fetch the page again and swap in the file list, the delete button and the places for 「移动到…」. */
async function refresh() {
  const r = await fetch(location.pathname, { headers: { accept: 'text/html' } }).catch(() => null);
  if (!r?.ok || !section) return;
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const fresh = doc.querySelector('#files');
  // Audio came or went so that the page is laid out differently (a track list appears or goes): load it all.
  if (!fresh || !!doc.querySelector('#ed-data') !== !!document.querySelector('#ed-data')) {
    if (!editor()?.changes()) location.reload();
    return;
  }
  section.innerHTML = fresh.innerHTML;
  // The delete button and 公开站 (its counts by rights) follow the files.
  for (const sel of ['#ed-delete', '#public']) {
    const part = doc.querySelector(sel);
    if (part) $(sel)?.replaceChildren(...[...part.childNodes].map((n) => document.importNode(n, true)));
  }
  const options = doc.querySelector('#place-picker [data-options]');
  const mine = $('#place-picker [data-options]');
  if (options && mine) {
    mine.textContent = options.textContent;
    resetPickerOptions();
  }
  const naming = doc.querySelector('#dlg-naming [data-naming]');
  if (naming) $('#dlg-naming [data-naming]')!.textContent = naming.textContent;
  for (const k of [...selected]) if (!rowOf(k)) selected.delete(k);
  applyClosed();
  paint();
  const ed = editor();
  if (ed && !(await ed.reload()) && ed.changes()) {
    toast(t('曲目列表有未保存的改动：其中的文件信息保存后再更新'));
  }
}

// ------------------------------------------------------------------------------------------ the actions

function inEditionFolders(): { id: string; name: string; role: string; depth: number }[] {
  return rows().filter((r) => !isFile(r.dataset.key!)).map((r) => ({ id: idOf(r.dataset.key!), name: r.dataset.name ?? '', role: r.dataset.role ?? '', depth: Number(r.dataset.depth) || 0 }));
}

/** Folders below a folder (in this edition), to keep a folder from moving into itself. */
function below(id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const r of rows()) {
    if (isFile(r.dataset.key!)) continue;
    if (out.has(r.dataset.parent ?? '')) out.add(idOf(r.dataset.key!));
  }
  return out;
}

async function moveTo(sel: Sel, key: string, newFolder = '') {
  await run(async () => {
    let under = key;
    if (sel.folders.length) {
      if (newFolder) {
        const made = await postJson('/admin/desk/folder', { op: 'create', under: key, name: newFolder });
        if (made.ok && made.id) under = folderKey(String(made.id));
      }
      if (!(await folderOp({ op: 'move', ids: sel.folders, under }))) return;
    }
    if (sel.files.length) {
      // A new folder was made for the folders already; else the files make it.
      const ok = await fileAction('move', sel.files, { target: under, new_folder: under === key ? newFolder : '', keep: '__none__' });
      if (!ok) return;
    }
    if (key.startsWith('fd:')) rememberPlace(key);
  });
}

async function pickAndMove(sel: Sel) {
  if (!sel.files.length && !sel.folders.length) return;
  const blocked = new Set(sel.folders.flatMap((id) => [...below(id)]));
  const first = sel.files.length ? rowOf(`f:${sel.files[0]}`) : rowOf(`d:${sel.folders[0]}`);
  const r = await openPicker({
    title: sel.folders.length ? t('把 {n} 个文件夹和文件移到…', { n: sel.folders.length }) : t('移动到…'),
    exclude: (key) => key === 'top' || blocked.has(key.slice(3)),
    current: folderKey(first?.dataset.parent || home()),
  });
  if (r) await moveTo(sel, r.target, r.newFolder);
}

async function remove(sel: Sel) {
  if (!sel.files.length && !sel.folders.length) return;
  const parts = [
    sel.files.length ? t('{n} 个文件：上传的文件进回收站（30 天内可恢复）；合辑里原件还在的只能忽略，会移出本版。', { n: sel.files.length }) : '',
    sel.folders.length ? t('{n} 个文件夹：文件夹删除，里面的文件退回「未归档」（文件本身不删）。', { n: sel.folders.length }) : '',
  ].filter(Boolean);
  if (!(await confirmBox(`${parts.join('\n')}\n${t('之后可以撤销。确定删除吗？')}`, t('确定删除')))) return;
  await run(async () => {
    if (sel.folders.length && !(await folderOp({ op: 'delete', ids: sel.folders }))) return;
    if (sel.files.length) await fileAction('discard', sel.files);
  });
}

function freeName(parent: string, base: string): string {
  const taken = new Set(rows().filter((r) => !isFile(r.dataset.key!) && r.dataset.parent === parent).map((r) => r.dataset.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
}

/** New folder: its name is asked for in a row where it will appear, then it is made (one history entry). */
async function newFolder(parent = home()) {
  if (!parent) return;
  const name = await askFolderName(parent, freeName(parent, t('新建文件夹')));
  if (name) await run(() => folderOp({ op: 'create', under: folderKey(parent), name }), { keep: true });
}

function askFolderName(parent: string, value: string): Promise<string | null> {
  const parentRow = rowOf(`d:${parent}`);
  const body = parentRow?.parentElement;
  if (!parentRow || !body) return Promise.resolve(null);
  const row = document.createElement('tr');
  row.className = 'folder-row';
  row.appendChild(Object.assign(document.createElement('td'), { className: 'sel' }));
  const name = row.appendChild(Object.assign(document.createElement('td'), { className: 'tree-name' }));
  name.style.setProperty('--depth', String(Number(parentRow.dataset.depth || 0) + 1));
  const icon = $('tr[data-role="plain"] .tree-name svg', section!) ?? $('.tree-name svg', parentRow);
  if (icon) name.appendChild(icon.cloneNode(true));
  name.appendChild(document.createElement('span')).dataset.nameSlot = '';
  row.appendChild(Object.assign(document.createElement('td'), { colSpan: 5 }));
  return nameNewFolder(body, parentRow.nextElementSibling, row, value);
}

/** Rename in the row: a file without its extension, or a folder; Enter saves, Esc cancels. */
async function startRename(key: string) {
  const row = rowOf(key);
  const link = row && $<HTMLElement>('.fname', row);
  if (!row || !link) return;
  const name = row.dataset.name ?? '';
  const ext = isFile(key) ? extOf(row) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  const value = await renameInPlace(link, { value: stem, ext, label: isFile(key) ? t('新文件名') : t('新名称'), row });
  if (value !== null) {
    if (isFile(key)) await run(() => renameFiles([[idOf(key), value + ext]]), { keep: true });
    else await run(() => folderOp({ op: 'rename', id: idOf(key), name: value }), { keep: true });
  }
  rowOf(key)?.focus({ preventScroll: true }); // the keys keep working on it
}

/** «.flac» when the name ends in the file's extension, else ''. */
function extOf(row: HTMLElement): string {
  const name = row.dataset.name ?? '';
  const ext = row.dataset.ext ?? '';
  return ext && name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name.slice(name.length - ext.length - 1) : '';
}

async function renameFiles(pairs: [string, string][]): Promise<string | null> {
  const r = await renameRequest(pairs);
  if (!r.ok) {
    toast(r.err ?? t('操作失败'), { error: true });
    return r.err ?? t('操作失败');
  }
  report(r);
  return null;
}

async function batchRename(ids: string[]) {
  const list: RenameFile[] = ids.map((id) => rowOf(`f:${id}`)).filter((r): r is HTMLTableRowElement => !!r).map((r) => {
    const name = r.dataset.name ?? '';
    const ext = extOf(r);
    return { id: idOf(r.dataset.key!), name, stem: ext ? name.slice(0, -ext.length) : name, ext, orig: r.dataset.orig ?? name };
  });
  if (!list.length) return;
  // The dialog stays open until the names are saved (a clash is shown in it) and the list is fetched again.
  await renameBox(list, (pairs) => queued(async () => {
    section?.classList.add('working');
    try {
      const problem = await renameFiles(pairs);
      if (!problem && !moreQueued()) await refresh();
      return problem;
    } finally {
      section?.classList.remove('working');
    }
  }));
}

function renameSelection() {
  const sel = current();
  if (sel.files.length === 1 && !sel.folders.length) startRename(`f:${sel.files[0]}`);
  else if (sel.files.length > 1 && !sel.folders.length) batchRename(sel.files);
  else if (!sel.files.length && sel.folders.length === 1) startRename(`d:${sel.folders[0]}`);
}

async function setCover(id: string) {
  const ed = editor();
  if (ed?.changes()) {
    toast(t('曲目列表有未保存的改动：先保存或放弃，再设封面'), { error: true });
    return;
  }
  if (!ed) {
    // An edition without a track list shows its cover above the files: load the page again, with the undo.
    const r = await postJson('/admin/desk/tags', { op: 'cover', file: id });
    if (!r.ok) {
      toast(String(r.err ?? t('操作失败')), { error: true });
      return;
    }
    const next = new URL(location.href);
    next.searchParams.set('msg', String(r.msg ?? ''));
    if (r.batch) next.searchParams.set('undo', String(r.batch));
    next.hash = '';
    location.href = next.toString();
    return;
  }
  await run(async () => {
    const r = await postJson('/admin/desk/tags', { op: 'cover', file: id });
    if (!r.ok) toast(String(r.err ?? t('操作失败')), { error: true });
    else report(r);
  }, { keep: true });
}

// ------------------------------------------------------------------------------------------ the menu

function menuFor(sel: Sel): MenuEntry[] {
  const one = sel.files.length + sel.folders.length === 1;
  const file = one && sel.files.length ? rowOf(`f:${sel.files[0]}`) : null;
  const folder = one && sel.folders.length ? rowOf(`d:${sel.folders[0]}`) : null;
  const role = folder?.dataset.role;
  const fixed = sel.folders.some((id) => rowOf(`d:${id}`)?.dataset.role !== 'plain');
  const entries: MenuEntry[] = [];
  if (file) {
    const id = sel.files[0];
    entries.push({ label: t('打开文件页'), keys: 'Enter', run: () => (location.href = `/admin/files/${id}`) });
    if (file.dataset.row && editor()) entries.push({ label: t('在曲目列表中编辑标签'), run: () => editor()!.openRow(file.dataset.row!) });
    if (file.dataset.cover) entries.push({ label: t('设为封面'), run: () => setCover(id) });
    if (file.dataset.tagged) entries.push({ label: t('下载（带标签）'), run: () => (location.href = `/admin/download/${id}?tagged=1`) });
    if (file.dataset.blob) entries.push({ label: file.dataset.kind === 'audio' ? t('下载原件') : t('下载'), run: () => (location.href = `/admin/download/${id}`) });
    entries.push('-', { label: t('重命名'), keys: 'F2', run: () => startRename(`f:${id}`) });
  } else if (folder) {
    const id = sel.folders[0];
    entries.push(
      { label: t('在整理台中打开'), run: () => (location.href = `/admin/inbox?loc=${folderKey(id)}`) },
      { label: t('新建子文件夹'), keys: 'Ctrl+Shift+N', run: () => newFolder(id) },
      '-',
    );
    if (role !== 'root') entries.push({ label: t('重命名'), keys: 'F2', run: () => startRename(`d:${id}`) });
  } else if (sel.files.length > 1 && !sel.folders.length) {
    entries.push({ label: t('批量重命名…'), keys: 'F2', run: () => batchRename(sel.files) }, '-');
  }
  if (!fixed) {
    entries.push({ label: t('移动到…'), keys: 'M', run: () => pickAndMove(sel) });
    // The edition's own folders, one click away (not where everything chosen already is).
    const blocked = new Set(sel.folders.flatMap((id) => [...below(id)]));
    const parents = new Set([...sel.files.map((id) => rowOf(`f:${id}`)?.dataset.parent), ...sel.folders.map((id) => rowOf(`d:${id}`)?.dataset.parent)]);
    for (const f of inEditionFolders().slice(0, 8)) {
      if (blocked.has(f.id) || (parents.size === 1 && parents.has(f.id))) continue;
      entries.push({ label: f.role === 'root' ? t('移到本版根目录') : t('移到「{name}」', { name: f.name }), run: () => moveTo(sel, folderKey(f.id)) });
    }
  }
  if (folder && role === 'plain') {
    entries.push({ label: t('解散文件夹（里面的东西移到上一级）'), run: () => run(() => folderOp({ op: 'merge', id: sel.folders[0], into: folderKey(folder.dataset.parent!) })) });
  }
  if (sel.files.length) {
    entries.push(
      '-',
      { label: t('忽略'), keys: 'I', run: () => run(() => fileAction('ignore', sel.files)) },
      { label: t('退回未归档'), run: () => run(() => fileAction('reset', sel.files)) },
      { label: t('标为重复'), run: () => run(() => fileAction('dup', sel.files)) },
      '-',
      { label: t('设为社团自有'), run: () => run(() => fileAction('rights', sel.files, { rights_value: 'own' }), { keep: true }) },
      { label: t('设为第三方'), run: () => run(() => fileAction('rights', sel.files, { rights_value: 'third_party' }), { keep: true }) },
      { label: t('设为已授权'), run: () => run(() => fileAction('rights', sel.files, { rights_value: 'licensed' }), { keep: true }) },
      { label: t('权利改回未知'), run: () => run(() => fileAction('rights', sel.files, { rights_value: 'unknown' }), { keep: true }) },
      { label: t('公开权限…'), run: () => window.dispatchEvent(new CustomEvent('rigel:access-select', { detail: sel.files })) },
    );
  }
  entries.push('-', {
    label: t('删除'), keys: 'Delete', danger: true, run: () => remove(sel),
    disabled: fixed ? t('版本在页面底部删除') : false,
  });
  return entries;
}

// ------------------------------------------------------------------------------------------ 带标签下载的文件名

interface NamingData { template: string; presets: string[]; samples: { parts: NameParts; ext: string }[] }

async function namingDialog() {
  const d = $<HTMLDialogElement>('#dlg-naming');
  if (!d) return;
  const data = JSON.parse($('[data-naming]', d)?.textContent ?? '{}') as NamingData;
  const form = $<HTMLFormElement>('form', d)!;
  const presets = $('[data-presets]', d)!;
  const custom = $<HTMLInputElement>('[data-custom]', d)!;
  const preview = $('[data-preview]', d)!;
  const err = $('[data-err]', d)!;
  const ok = $<HTMLButtonElement>('[data-ok]', d)!;
  const example = (template: string) => data.samples.map((s) => `${renderName(template, s.parts) || '…'}.${s.ext}`);
  presets.replaceChildren(...data.presets.map((p) => {
    const label = document.createElement('label');
    label.className = 'naming-preset';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'naming';
    radio.value = p;
    const code = document.createElement('code');
    code.textContent = p;
    const eg = document.createElement('span');
    eg.className = 'muted small';
    eg.textContent = example(p)[0] ?? '';
    for (const part of [radio, document.createTextNode(' '), code, document.createTextNode(' '), eg]) label.appendChild(part);
    return label;
  }));
  const isPreset = data.presets.includes(data.template);
  custom.value = data.template;
  for (const r of $$<HTMLInputElement>('input[name="naming"]', form)) r.checked = isPreset ? r.value === data.template : r.value === 'custom';
  const chosen = () => {
    const r = $<HTMLInputElement>('input[name="naming"]:checked', form);
    return !r || r.value === 'custom' ? custom.value : r.value;
  };
  const render = () => {
    const template = chosen();
    const problem = namingProblem(template);
    err.textContent = problem ? t(problem) : '';
    ok.disabled = !!problem;
    const list = document.createElement('ul');
    for (const name of problem ? [] : example(template)) {
      const li = document.createElement('li');
      li.textContent = name;
      list.appendChild(li);
    }
    preview.replaceChildren(...(problem ? [] : [Object.assign(document.createElement('span'), { className: 'muted small', textContent: t('本版前几首将下载为：') }), list]));
  };
  const onInput = (e: Event) => {
    if (e.target === custom) $<HTMLInputElement>('input[name="naming"][value="custom"]', form)!.checked = true;
    render();
  };
  form.addEventListener('input', onInput);
  render();
  const choice = await new Promise<string>((resolve) => {
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue), { once: true });
    d.showModal();
  });
  form.removeEventListener('input', onInput);
  if (choice !== 'ok' || chosen().trim() === data.template) return;
  await run(async () => {
    const r = await postJson('/admin/download-naming', { template: chosen() });
    if (!r.ok) toast(String(r.err ?? t('保存失败')), { error: true });
    else toast(String(r.msg ?? ''));
  }, { keep: true });
}

// ------------------------------------------------------------------------------------------ 整理非音频文件

/**
 * The non-audio files directly in the edition's folder (LOG, CUE, scans, notes; not archives kept whole),
 * by kind, into a folder of the edition or a new one under its root: one move, undone as one.
 */
async function tidyDialog() {
  const d = $<HTMLDialogElement>('#dlg-tidy');
  if (!d) return;
  const loose = rows().filter((r) => isFile(r.dataset.key!) && r.dataset.parent === home() && r.dataset.loose);
  if (!loose.length) return;
  const form = $<HTMLFormElement>('form', d)!;
  const ok = $<HTMLButtonElement>('[data-ok]', d)!;
  const err = $('[data-err]', d)!;
  const name = $<HTMLInputElement>('[data-new]', d)!;
  // The kinds, with their files and extensions.
  const kinds = new Map<string, { label: string; ids: string[]; exts: Set<string> }>();
  for (const r of loose) {
    const k = kinds.get(r.dataset.kind ?? '') ?? { label: r.dataset.loose!, ids: [], exts: new Set<string>() };
    k.ids.push(idOf(r.dataset.key!));
    if (r.dataset.ext) k.exts.add(r.dataset.ext.toLowerCase());
    kinds.set(r.dataset.kind ?? '', k);
  }
  $('[data-kinds]', d)!.replaceChildren(...[...kinds].map(([kind, k]) => {
    const label = document.createElement('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, value: kind });
    box.dataset.kind = kind;
    const exts = Object.assign(document.createElement('span'), { className: 'muted small', textContent: [...k.exts].sort().join(t('、')) });
    for (const part of [box, document.createTextNode(` ${k.label} ${t('{n} 个', { n: k.ids.length })} `), exts]) label.appendChild(part);
    return label;
  }));
  // The edition's folders, by their path below its root.
  const folders = inEditionFolders().filter((f) => f.role === 'plain');
  const pathOf = (id: string): string => {
    const row = rowOf(`d:${id}`);
    const parent = row?.dataset.parent ?? '';
    const own = row?.dataset.name ?? '';
    return parent && parent !== home() ? `${pathOf(parent)} / ${own}` : own;
  };
  $('[data-folders]', d)!.replaceChildren(...folders.map((f) => {
    const label = document.createElement('label');
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'tidy-target', value: f.id });
    for (const part of [radio, document.createTextNode(` ${pathOf(f.id)}`)]) label.appendChild(part);
    return label;
  }));
  // A folder named 附件 right under the root is the likely place; else a new one, named 附件 to start with.
  const usual = t('附件');
  const same = folders.find((f) => f.depth === 1 && f.name === usual);
  name.value = usual;
  for (const r of $$<HTMLInputElement>('input[name="tidy-target"]', form)) r.checked = r.value === (same?.id ?? 'new');
  const chosen = () => $$<HTMLInputElement>('input[data-kind]', form).filter((b) => b.checked).flatMap((b) => kinds.get(b.value)?.ids ?? []);
  const target = () => $<HTMLInputElement>('input[name="tidy-target"]:checked', form)?.value ?? 'new';
  const render = () => {
    const n = chosen().length;
    const newName = name.value.trim();
    const problem = !n
      ? t('至少勾选一种')
      : target() === 'new' && !newName ? t('文件夹名称不能为空')
        : target() === 'new' && newName.includes('/') ? t('文件夹名称里不能有「/」') : '';
    err.textContent = problem;
    ok.disabled = !!problem;
    ok.textContent = t('移动 {n} 个文件', { n });
  };
  const onInput = (e: Event) => {
    if (e.target === name) $<HTMLInputElement>('input[name="tidy-target"][value="new"]', form)!.checked = true;
    render();
  };
  form.addEventListener('input', onInput);
  // Enter in the name moves (the form's first button is 取消).
  name.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!ok.disabled) d.close('ok');
  };
  render();
  const choice = await new Promise<string>((resolve) => {
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue), { once: true });
    d.showModal();
  });
  form.removeEventListener('input', onInput);
  if (choice !== 'ok' || !chosen().length) return;
  const where = target();
  if (where === 'new') await moveTo({ files: chosen(), folders: [] }, folderKey(home()), name.value.trim());
  else await moveTo({ files: chosen(), folders: [] }, folderKey(where));
}

// ------------------------------------------------------------------------------------------ wiring

function initDrag() {
  const label = $('#desk-drag');
  let dragging: Sel | null = null;
  const target = (ev: DragEvent) => (ev.target as HTMLElement).closest<HTMLTableRowElement>('tr.folder-row');
  const allowed = (row: HTMLElement): boolean => {
    if (!dragging) return false;
    const id = idOf(row.dataset.key!);
    if (dragging.folders.some((f) => below(f).has(id))) return false;
    const parents = new Set([...dragging.files.map((f) => rowOf(`f:${f}`)?.dataset.parent), ...dragging.folders.map((f) => rowOf(`d:${f}`)?.dataset.parent)]);
    return !(parents.size === 1 && parents.has(id));
  };
  const clear = () => $$('.drop-over', section!).forEach((e) => e.classList.remove('drop-over'));
  section!.addEventListener('dragstart', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-key]');
    if (!row || !row.draggable) return;
    if (!selected.has(row.dataset.key!)) selectOnly(row.dataset.key!);
    dragging = current();
    if (dragging.folders.some((id) => rowOf(`d:${id}`)?.dataset.role !== 'plain')) {
      ev.preventDefault();
      dragging = null;
      return;
    }
    ev.dataTransfer?.setData('text/plain', [...dragging.files, ...dragging.folders].join(','));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  section!.addEventListener('dragend', () => {
    dragging = null;
    clear();
    if (label) label.hidden = true;
  });
  section!.addEventListener('dragover', (ev) => {
    if (!dragging) return;
    const row = target(ev);
    clear();
    if (!row || !allowed(row)) {
      if (label) label.hidden = true;
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-over');
    if (label) {
      const n = dragging.files.length + dragging.folders.length;
      label.textContent = t('把 {n} 个移到「{name}」', { n, name: row.dataset.name ?? '' });
      label.classList.remove('no');
      label.hidden = false;
      label.style.left = `${ev.clientX + 14}px`;
      label.style.top = `${ev.clientY + 14}px`;
    }
  });
  section!.addEventListener('drop', (ev) => {
    const row = target(ev);
    if (!dragging || !row || !allowed(row)) return;
    ev.preventDefault();
    const what = dragging;
    dragging = null;
    clear();
    if (label) label.hidden = true;
    moveTo(what, folderKey(idOf(row.dataset.key!)));
  });
}

function init() {
  if (!section) return;
  section.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const act = el.closest<HTMLElement>('[data-files-act]')?.dataset.filesAct;
    if (act) {
      const sel = current();
      switch (act) {
        case 'new-folder': newFolder(sel.folders.length === 1 && !sel.files.length ? sel.folders[0] : home()); break;
        case 'move': pickAndMove(sel); break;
        case 'rename': renameSelection(); break;
        case 'ignore': run(() => fileAction('ignore', sel.files)); break;
        case 'delete': remove(sel); break;
        case 'clear': clearSelection(); break;
        case 'naming': namingDialog(); break;
        case 'tidy': tidyDialog(); break;
        case 'more': {
          const r = el.getBoundingClientRect();
          openMenu(menuFor(sel), r.left, r.bottom + 4);
          break;
        }
      }
      return;
    }
    if (el.matches('input[data-sel-all]')) {
      const on = (el as HTMLInputElement).checked;
      selected.clear();
      if (on) for (const r of rows().filter((x) => selectable(x) && !x.hidden)) selected.add(r.dataset.key!);
      paint();
      return;
    }
    const row = el.closest<HTMLTableRowElement>('tr[data-key]');
    if (!row) return;
    const key = row.dataset.key!;
    if (el.closest('[data-twisty]')) {
      toggleFolder(key);
      return;
    }
    if (el.closest('[data-row-menu]')) {
      if (!selected.has(key)) selectOnly(key);
      const r = el.getBoundingClientRect();
      openMenu(menuFor(current()), r.left, r.bottom + 4);
      return;
    }
    if (el.matches('input[data-sel]')) {
      toggle(key, (ev as MouseEvent).shiftKey);
      return;
    }
    if (el.closest('a, button, input, select, textarea, .rename-box') || !selectable(row)) return;
    const e = ev as MouseEvent;
    if (e.ctrlKey || e.metaKey || e.shiftKey) toggle(key, e.shiftKey);
    else selectOnly(key);
    row.focus({ preventScroll: true });
  });
  // A folder's row opens and closes on a double click (its name is a link to the 整理台).
  section.addEventListener('dblclick', (ev) => {
    const el = ev.target as HTMLElement;
    const row = el.closest<HTMLTableRowElement>('tr.folder-row[data-key]');
    if (row && !el.closest('a, button, input')) toggleFolder(row.dataset.key!);
  });
  section.addEventListener('contextmenu', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-key]');
    if (!row || (ev.target as HTMLElement).closest('input')) return;
    ev.preventDefault();
    if (!selected.has(row.dataset.key!)) {
      if (selectable(row)) selectOnly(row.dataset.key!);
      else {
        // The edition's own folder: its menu without selecting it.
        openMenu(menuFor({ files: [], folders: [idOf(row.dataset.key!)] }), ev.clientX, ev.clientY);
        return;
      }
    }
    openMenu(menuFor(current()), ev.clientX, ev.clientY);
  });
  // Keys work while the focus is in the list, or nowhere in particular (after a rename or a download).
  document.addEventListener('keydown', (ev) => {
    const el = ev.target as HTMLElement;
    if (!section.contains(el) && el !== document.body) return;
    if (el.closest('input[type="text"], textarea, select, .rename-box') || !selected.size || document.querySelector('dialog[open]')) return;
    const sel = current();
    if (ev.key === 'F2') {
      ev.preventDefault();
      renameSelection();
    } else if (ev.key === 'Delete') {
      ev.preventDefault();
      remove(sel);
    } else if (ev.key === 'Escape') {
      clearSelection();
    } else if ((ev.key === 'm' || ev.key === 'M') && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      pickAndMove(sel);
    } else if ((ev.key === 'i' || ev.key === 'I') && !ev.ctrlKey && !ev.metaKey && sel.files.length) {
      ev.preventDefault();
      run(() => fileAction('ignore', sel.files));
    } else if (ev.key === 'Enter' && sel.files.length === 1 && !sel.folders.length && el.matches('tr[data-key]')) {
      location.href = `/admin/files/${sel.files[0]}`;
    } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'N' || ev.key === 'n')) {
      ev.preventDefault();
      newFolder(sel.folders.length === 1 && !sel.files.length ? sel.folders[0] : home());
    }
  });
  // Rows can take the focus (for the keys above) once clicked.
  const focusable = () => rows().forEach((r) => (r.tabIndex = -1));
  new MutationObserver(focusable).observe(section, { childList: true });
  focusable();
  document.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('#desk-toast [data-act]');
    if (!act) return;
    if (act.dataset.act === 'undo-toast') undo(act.dataset.batch || null);
    if (act.dataset.act === 'close-toast') $('#desk-toast')!.hidden = true;
  });
  initDrag();
  paint();
}

init();
