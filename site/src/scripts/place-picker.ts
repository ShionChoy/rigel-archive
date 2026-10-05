// 「移动到…」: pick a place in the archive (components/PlacePicker.astro). The places are a folder tree like
// the 整理台's 已归档 tree: a triangle opens a folder and lists its subfolders, then its files (greyed: only
// folders can be chosen); the way to where the files are now is open. The last places used are listed
// above it with their full paths. Typing searches every folder by its full path (every word must match).

import { t } from './i18n';
import { fileNode, folderFiles, folderIcon, put } from './tree';

interface Option {
  key: string; // fd:<id>, or top
  path: string;
  name: string;
  kind: string; // a folder's type (plain, era, release, edition), or top
  depth: number;
  parent: string | null; // its parent's key
  folded: string; // the path, for searching
}

export interface PickResult {
  target: string;
  newFolder: string;
  keep: boolean;
}

export interface PickOptions {
  title?: string;
  confirm?: string;
  /** Show 「保留子文件夹结构」 for files taken from this original folder. */
  keepDir?: string | null;
  /** Places that cannot be chosen (a folder cannot move into itself). */
  exclude?: (key: string) => boolean;
  /** The top level can be chosen (moving folders); files need a folder. */
  allowTop?: boolean;
  /** Only choose a folder to open (Ctrl+J): no new folder, no sub-structure. */
  go?: boolean;
  /** Where the things moved are now: the tree opens the way to it and marks it. */
  current?: string | null;
}

const RECENT = 'rigel.recentPlaces';

export function recentPlaces(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT) ?? '[]');
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberPlace(key: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([key, ...recentPlaces().filter((k) => k !== key)].slice(0, 5)));
  } catch {
    // private mode: no recent places
  }
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const placeable = (o: Option, allowTop = false) => allowTop || o.kind !== 'top';

let options: Option[] | null = null;

/** The page was reloaded in place (a folder added or moved): read the options again next time. */
export function resetPickerOptions() {
  options = null;
}

type Raw = { key: string; path: string; name?: string; kind: string; depth: number; parent?: string | null };

export function pickerOptions(): Option[] {
  if (!options) {
    const own = document.querySelector('#place-picker [data-options]')?.textContent;
    // The 整理台 does not repeat its folders for the picker: they are in its #desk-data, in tree order.
    const list: Raw[] = own
      ? (JSON.parse(own) as Raw[])
      : [
        { key: 'top', path: t('顶层'), kind: 'top', depth: 0 },
        ...((JSON.parse(document.querySelector('#desk-data')?.textContent ?? '{}') as { folders?: { id: string; parent: string | null; name: string; path: string; kind: string; depth: number }[] }).folders ?? [])
          .map((f) => ({ key: `fd:${f.id}`, path: f.path, name: f.name, kind: f.kind, depth: f.depth + 1, parent: f.parent ? `fd:${f.parent}` : null })),
      ];
    options = list.map((o) => ({ ...o, name: o.name ?? o.path.split(' / ').at(-1) ?? o.path, parent: o.parent ?? null, folded: fold(o.path) }));
  }
  return options;
}

export function placePath(key: string): string {
  return pickerOptions().find((o) => o.key === key)?.path ?? key;
}

export function openPicker(opts: PickOptions = {}): Promise<PickResult | null> {
  const dialog = document.querySelector<HTMLDialogElement>('#place-picker');
  if (!dialog) return Promise.resolve(null);
  const all = pickerOptions().filter((o) => o.kind !== 'top' || opts.allowTop);
  const byKey = new Map(all.map((o) => [o.key, o]));
  const kids = new Map<string | null, Option[]>();
  for (const o of all) if (o.kind !== 'top') kids.set(o.parent, [...(kids.get(o.parent) ?? []), o]);
  const search = dialog.querySelector<HTMLInputElement>('[data-search]')!;
  const list = dialog.querySelector<HTMLUListElement>('[data-list]')!;
  const ok = dialog.querySelector<HTMLButtonElement>('[data-ok]')!;
  const newFolder = dialog.querySelector<HTMLInputElement>('[data-new-folder]')!;
  const keepRow = dialog.querySelector<HTMLElement>('[data-keep-row]')!;
  const keep = dialog.querySelector<HTMLInputElement>('[data-keep]')!;
  const chosenText = dialog.querySelector<HTMLElement>('[data-chosen]')!;
  dialog.querySelector('[data-title]')!.textContent = opts.title ?? t('移动到…');
  (dialog.querySelector('[data-new-row]') as HTMLElement).hidden = !!opts.go;
  ok.textContent = opts.confirm ?? t('移动到这里');
  search.value = '';
  newFolder.value = '';
  keepRow.hidden = !opts.keepDir;
  keep.checked = false;
  dialog.querySelector('[data-keep-label]')!.textContent = opts.keepDir ? t('保留「{dir}」下的子文件夹结构', { dir: opts.keepDir }) : '';
  let chosen: Option | null = null;
  const top = !!opts.allowTop || !!opts.go;
  const allowed = (o: Option) => !opts.exclude?.(o.key);

  // The way to where things are now is open.
  const open = new Set<string>();
  for (let k = opts.current ? byKey.get(opts.current)?.parent ?? null : null; k; k = byKey.get(k)?.parent ?? null) open.add(k);

  const update = () => {
    const canFile = !!chosen && (placeable(chosen, top) || newFolder.value.trim() !== '');
    ok.disabled = !canFile;
    const extra = newFolder.value.trim();
    chosenText.textContent = chosen
      ? `${opts.go ? '' : t('移到：')}${chosen.path}${extra ? ` / ${extra}` : ''}${!placeable(chosen, top) && !extra ? ` — ${t('顶层只能放文件夹，请选一个文件夹或输入新文件夹名')}` : ''}`
      : t('请选择位置');
  };

  /** A folder's row: the triangle opens it, a click chooses it (unless it cannot be chosen). */
  const folderRow = (o: Option, depth: number, full = false): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = `fnode${open.has(o.key) && !full ? ' open' : ''}`;
    li.dataset.key = o.key;
    li.setAttribute('role', 'treeitem');
    const row = li.appendChild(document.createElement('div'));
    row.className = `frow${allowed(o) ? '' : ' disabled'}${o === chosen ? ' chosen' : ''}`;
    row.dataset.key = o.key;
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('aria-selected', String(o === chosen));
    if (full) row.title = o.path;
    const tw = document.createElement('button');
    tw.type = 'button';
    tw.tabIndex = -1;
    tw.className = full || o.kind === 'top' ? 'twisty none' : 'twisty';
    tw.setAttribute('aria-label', t('展开或收起'));
    put(row, tw, o.kind === 'top' ? Object.assign(document.createElement('span'), { className: 'ficon top' }) : folderIcon(o.kind));
    row.appendChild(Object.assign(document.createElement('span'), { className: 'fname', textContent: full ? o.path : o.name }));
    if (!full && o.key === opts.current) row.appendChild(Object.assign(document.createElement('span'), { className: 'chip', textContent: t('当前位置') }));
    if (!full && o.kind !== 'top') {
      li.appendChild(Object.assign(document.createElement('ul'), { className: 'ftree' })).setAttribute('role', 'group');
      if (li.classList.contains('open')) fill(li, o, depth);
    }
    return li;
  };

  /** An open folder: its subfolders, then its files (fetched once). */
  const fill = (li: HTMLElement, o: Option, depth: number) => {
    const ul = li.querySelector<HTMLElement>(':scope > ul')!;
    if (ul.dataset.filled) return;
    ul.dataset.filled = '1';
    ul.replaceChildren(...(kids.get(o.key) ?? []).map((c) => folderRow(c, depth + 1)));
    folderFiles([o.key.slice(3)]).then((got) => {
      const v = got.get(o.key.slice(3));
      if (!v) return;
      const rows = v.files.map((f) => fileNode(f, depth + 1));
      if (v.more) rows.push(Object.assign(document.createElement('li'), { className: 'fnode leaf more-files muted small', textContent: t('还有 {n} 个文件', { n: v.more }) }));
      for (const r of rows) r.querySelector('.frow')?.classList.add('inert');
      put(ul, ...rows);
      if (!v.files.length && !kids.get(o.key)?.length) {
        const empty = Object.assign(document.createElement('li'), { className: 'fnode leaf empty-note muted small', textContent: t('（空文件夹）') });
        empty.style.setProperty('--depth', String(depth + 1));
        ul.appendChild(empty);
      }
    });
  };

  const toggle = (li: HTMLElement, to = !li.classList.contains('open')) => {
    const o = byKey.get(li.dataset.key!);
    if (!o || o.kind === 'top') return;
    li.classList.toggle('open', to);
    if (to) {
      open.add(o.key);
      fill(li, o, Number(li.querySelector<HTMLElement>(':scope > .frow')?.style.getPropertyValue('--depth') || 0));
    } else open.delete(o.key);
  };

  const label = (text: string) => Object.assign(document.createElement('li'), { className: 'picker-label', textContent: text });

  const render = () => {
    const words = fold(search.value).split(/\s+/).filter(Boolean);
    if (words.length) {
      const found = all
        .filter((o) => words.every((w) => o.folded.includes(w)))
        .sort((a, b) => a.depth - b.depth || a.path.length - b.path.length)
        .slice(0, 200);
      list.replaceChildren(...(found.length ? found.map((o) => folderRow(o, 0, true)) : [label(t('没有找到'))]));
    } else {
      const recent = recentPlaces().map((k) => byKey.get(k)).filter((o): o is Option => !!o && o.kind !== 'top');
      const roots = [...all.filter((o) => o.kind === 'top'), ...(kids.get(null) ?? [])];
      list.replaceChildren(
        ...(recent.length ? [label(t('最近使用')), ...recent.map((o) => folderRow(o, 0, true)), label(t('全部位置'))] : []),
        ...roots.map((o) => folderRow(o, 0)),
      );
    }
    update();
    list.querySelector('.frow[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  const choose = (o: Option | null) => {
    if (o && !allowed(o)) return;
    chosen = o;
    for (const row of list.querySelectorAll<HTMLElement>('.frow[data-key]')) {
      const on = row.dataset.key === o?.key;
      row.classList.toggle('chosen', on);
      row.setAttribute('aria-selected', String(on));
    }
    list.querySelector('.frow.chosen')?.scrollIntoView({ block: 'nearest' });
    update();
  };

  /** The folder rows one can see, in order (for the arrow keys). */
  const visibleRows = () => [...list.querySelectorAll<HTMLElement>('.frow[data-key]')].filter((r) => r.offsetParent !== null);

  // The way to where things are now is open: show it.
  render();
  if (opts.current) list.querySelector<HTMLElement>(`.frow[data-key="${opts.current}"]`)?.scrollIntoView({ block: 'center' });

  return new Promise((resolve) => {
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('.frow[data-key]');
      if (!row) return;
      if (target.closest('.twisty')) {
        toggle(row.closest<HTMLElement>('li.fnode')!);
        return;
      }
      choose(byKey.get(row.dataset.key!) ?? null);
      if ((e as MouseEvent).detail === 2 && !ok.disabled) {
        dialog.returnValue = 'ok';
        dialog.close('ok');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter'].includes(e.key)) return;
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target !== search && e.target !== list) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!chosen && search.value.trim()) choose(byKey.get(visibleRows()[0]?.dataset.key ?? '') ?? null);
        if (!ok.disabled) dialog.close('ok');
        return;
      }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (search.value || !chosen)) return;
      e.preventDefault();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const li = list.querySelector<HTMLElement>(`.frow.chosen`)?.closest<HTMLElement>('li.fnode');
        if (!li) return;
        if (e.key === 'ArrowRight') toggle(li, true);
        else if (li.classList.contains('open')) toggle(li, false);
        else choose(byKey.get(byKey.get(li.dataset.key!)?.parent ?? '') ?? chosen);
        return;
      }
      const rows = visibleRows().filter((r) => !r.classList.contains('disabled'));
      const at = rows.findIndex((r) => r.classList.contains('chosen'));
      const next = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)];
      if (next) choose(byKey.get(next.dataset.key!) ?? null);
    };
    const onClose = () => {
      list.removeEventListener('click', onClick);
      dialog.removeEventListener('keydown', onKey);
      search.removeEventListener('input', render);
      newFolder.removeEventListener('input', update);
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue === 'ok' && chosen) {
        if (!opts.go && chosen.kind !== 'top') rememberPlace(chosen.key);
        resolve({ target: chosen.key, newFolder: newFolder.value.trim(), keep: keep.checked });
      } else resolve(null);
    };
    list.addEventListener('click', onClick);
    dialog.addEventListener('keydown', onKey);
    search.addEventListener('input', render);
    newFolder.addEventListener('input', update);
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
    search.focus();
  });
}
