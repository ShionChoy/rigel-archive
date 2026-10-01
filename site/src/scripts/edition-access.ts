// 版本页「公开站」 (pages/admin/editions/[id].astro, 设计文档「文件权限方案 · 管理界面」): the edition's
// defaults are a plain form; this makes the file table work. Click a cell to change that one file, or tick
// files (Shift for a range, the header for all shown) and change them together from the bar; filters narrow
// the table. Each change is one request to /admin/editions/<id>/access, one entry in the history with
// 「撤销」 in the message; the table is fetched again afterwards (with the 「文件」 list, scripts/edition-files.ts).

import { t } from './i18n';
import { closeMenu, openMenu, toast, type MenuEntry } from './desk-ui';
import { postJson, queued, report } from './file-ops';
import { withFilesRefresh } from './edition-files';

const section = document.querySelector<HTMLElement>('#public');
const selected = new Set<string>();
let anchor: string | null = null;
let filter = 'all';

// The Workers types clash with the DOM's ParentNode here; these take any element.
const $ = <E extends Element = HTMLElement>(sel: string, root: unknown = section) => (root ? (root as ParentNode).querySelector<E>(sel) : null);
const $$ = <E extends Element = HTMLElement>(sel: string, root: unknown = section) => (root ? [...(root as ParentNode).querySelectorAll<E>(sel)] : []);
const selects = (sel: string, root: unknown) => $$(sel, root) as unknown as HTMLSelectElement[];
const rows = () => $$<HTMLTableRowElement>('tr[data-id]');
const shownRows = () => rows().filter((r) => !r.hidden);

const LABELS = {
  rights: { own: t('社团自有'), licensed: t('已获授权'), third_party: t('第三方（只列条目）'), unknown: t('未定') } as Record<string, string>,
  pub_visible: { '1': t('可见'), '0': t('隐藏') } as Record<string, string>,
  pub_play: { full: t('允许'), clip: t('仅试听…'), none: t('不允许') } as Record<string, string>,
  pub_quality: { original: t('原件（最高）'), lossless: t('无损（推流 FLAC）'), lossy: t('省流（AAC 256 kbps）') } as Record<string, string>,
  pub_download: { '1': t('允许'), '0': t('不允许') } as Record<string, string>,
};

// ------------------------------------------------------------------------------------------ selection and filters

function matches(row: HTMLElement): boolean {
  if (filter === 'all') return true;
  return (row.dataset.flags ?? '').split(' ').includes(filter);
}

function paint() {
  if (!section) return;
  for (const r of rows()) {
    r.hidden = !matches(r);
    const on = selected.has(r.dataset.id!);
    r.classList.toggle('selected', on);
    const box = $<HTMLInputElement>('input[data-pub-pick]', r);
    if (box) box.checked = on;
  }
  // Group headings go with their rows.
  for (const g of $$<HTMLTableRowElement>('tr.pub-group')) {
    let next = g.nextElementSibling as HTMLElement | null;
    let any = false;
    while (next && !next.classList.contains('pub-group')) {
      if (!next.hidden) any = true;
      next = next.nextElementSibling as HTMLElement | null;
    }
    g.hidden = !any;
  }
  for (const b of $$<HTMLButtonElement>('button[data-filter]')) b.classList.toggle('on', b.dataset.filter === filter);
  const shown = shownRows();
  const n = shown.filter((r) => selected.has(r.dataset.id!)).length;
  const all = $<HTMLInputElement>('input[data-pub-all]');
  if (all) {
    all.checked = n > 0 && n === shown.length;
    all.indeterminate = n > 0 && n < shown.length;
  }
  const bar = $('[data-pub-bar]');
  if (bar) {
    bar.hidden = selected.size === 0;
    $('[data-count]', bar)!.textContent = String(selected.size);
  }
}

function toggleRow(id: string, range: boolean) {
  if (range && anchor) {
    const ids = shownRows().map((r) => r.dataset.id!);
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(x);
      return paint();
    }
  }
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  anchor = id;
  paint();
}

// ------------------------------------------------------------------------------------------ saving

const editionId = () => section?.dataset.edition ?? '';

/** Send a change for these files; the table (and the file list) is fetched again afterwards. */
async function send(body: Record<string, unknown>): Promise<boolean> {
  let ok = false;
  const work = async () => {
    const r = await postJson(`/admin/editions/${editionId()}/access`, body);
    if (!r.ok) {
      toast(String(r.err ?? t('操作失败')), { error: true });
      return;
    }
    report(r);
    ok = true;
  };
  if (document.querySelector('#files')) {
    // In the file list's queue: it fetches both parts again after the last action.
    section?.classList.add('working');
    try {
      await withFilesRefresh(work);
    } finally {
      section?.classList.remove('working');
    }
    return ok;
  }
  await queued(async () => {
    section?.classList.add('working');
    try {
      await work();
      if (ok) await refreshPanel();
    } finally {
      section?.classList.remove('working');
    }
  });
  return ok;
}

/** Fetch 公开站 again (a page without the 「文件」 list). */
async function refreshPanel() {
  const r = await fetch(location.pathname, { headers: { accept: 'text/html' } }).catch(() => null);
  if (!r?.ok || !section) return;
  const fresh = new DOMParser().parseFromString(await r.text(), 'text/html').querySelector('#public');
  if (fresh) section.replaceChildren(...[...fresh.childNodes].map((n) => document.importNode(n, true)));
}

/** Ask for a preview clip's range: start («1:30» or «30%») and length (seconds). Null when cancelled. */
function askClip(current: string): Promise<{ start: string; length: string } | 'inherit' | null> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-clip');
  if (!d) return Promise.resolve(null);
  const m = /^(.*) \S+ (\d+) \S+$/.exec(current);
  const start = d.querySelector<HTMLInputElement>('[data-start]')!;
  const length = d.querySelector<HTMLInputElement>('[data-length]')!;
  if (m) {
    start.value = m[1];
    length.value = m[2];
  }
  d.returnValue = '';
  d.showModal();
  start.focus();
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      if (d.returnValue === 'ok') resolve({ start: start.value, length: length.value });
      else if (d.returnValue === 'inherit') resolve('inherit');
      else resolve(null);
    }, { once: true });
  });
}

/** The menu of a cell: the values it can take, and following the edition again. */
function cellMenu(cell: HTMLElement) {
  const row = cell.closest<HTMLElement>('tr[data-id]')!;
  const id = row.dataset.id!;
  const field = cell.dataset.field as keyof typeof LABELS;
  const current = cell.dataset.value ?? '';
  const ids = selected.has(id) && selected.size > 1 ? [...selected] : [id];
  const many = ids.length > 1 ? ` (${ids.length})` : '';
  const entries: MenuEntry[] = [];
  let values = Object.keys(LABELS[field]);
  // A preview clip is for sound only.
  if (field === 'pub_play' && row.dataset.kind !== 'audio' && ids.length === 1) values = values.filter((v) => v !== 'clip');
  for (const v of values) {
    entries.push({
      label: `${v === current ? '✓ ' : ''}${LABELS[field][v]}${many}`,
      run: async () => {
        if (field === 'pub_play' && v === 'clip') {
          const range = await askClip(row.dataset.clip ?? '');
          if (!range) return;
          await send({ op: 'files', ids, patch: range === 'inherit' ? { pub_play: 'clip', pub_clip: null } : { pub_play: 'clip', pub_clip: range } });
          return;
        }
        await send({ op: 'files', ids, patch: { [field]: v } });
      },
    });
  }
  if (field !== 'rights') entries.push('-', { label: t('跟随本版') + many, run: () => void send({ op: 'files', ids, patch: field === 'pub_play' ? { pub_play: null, pub_clip: null } : { [field]: null } }) });
  const box = cell.getBoundingClientRect();
  openMenu(entries, box.left, box.bottom + 2);
}

function applyBar() {
  const bar = $('[data-pub-bar]')!;
  const patch: Record<string, unknown> = {};
  for (const el of selects('select[data-bar]', bar)) if (el.value) patch[el.dataset.bar!] = el.value;
  if (patch.pub_play === 'clip') {
    patch.pub_clip = { start: $<HTMLInputElement>('input[data-bar="clip_start"]', bar)!.value, length: $<HTMLInputElement>('input[data-bar="clip_length"]', bar)!.value };
  }
  if (Object.keys(patch).length === 0) return toast(t('先在栏里选要改的设置'), { error: true });
  void send({ op: 'files', ids: [...selected], patch }).then((ok) => {
    if (ok) for (const el of selects('select[data-bar]', bar)) el.value = '';
  });
}

// ------------------------------------------------------------------------------------------ wiring

if (section) {
  section.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const pick = target.closest<HTMLInputElement>('input[data-pub-pick]');
    if (pick) {
      // Let the box change (never preventDefault on it); the selection follows it.
      toggleRow(pick.closest<HTMLElement>('tr[data-id]')!.dataset.id!, ev.shiftKey);
      return;
    }
    const all = target.closest<HTMLInputElement>('input[data-pub-all]');
    if (all) {
      const shown = shownRows().map((r) => r.dataset.id!);
      if (all.checked) shown.forEach((id) => selected.add(id));
      else shown.forEach((id) => selected.delete(id));
      paint();
      return;
    }
    const f = target.closest<HTMLButtonElement>('button[data-filter]');
    if (f) {
      filter = f.dataset.filter ?? 'all';
      paint();
      return;
    }
    const cell = target.closest<HTMLButtonElement>('button[data-field]');
    if (cell) {
      ev.stopPropagation();
      cellMenu(cell);
      return;
    }
    const act = target.closest<HTMLButtonElement>('[data-bar-act]');
    if (act?.dataset.barAct === 'apply') applyBar();
    else if (act?.dataset.barAct === 'reset') void send({ op: 'reset', ids: [...selected] });
    else if (act?.dataset.barAct === 'clear') {
      selected.clear();
      paint();
    }
  });
  section.addEventListener('change', (ev) => {
    const target = ev.target as HTMLElement;
    // The preview clip's range shows when 「仅试听」 is chosen (the defaults' form, the bar).
    if (target.matches('select[data-play-select]')) {
      const fields = $('[data-clip-fields]');
      if (fields) fields.hidden = (target as unknown as HTMLSelectElement).value !== 'clip';
    }
    if (target.matches('select[data-bar="pub_play"]')) {
      const fields = $('[data-bar-clip]');
      if (fields) fields.hidden = (target as unknown as HTMLSelectElement).value !== 'clip';
    }
  });
  // The table is swapped in again after every change: keep the selection and the filter on it.
  new MutationObserver(() => {
    for (const id of [...selected]) if (!rows().some((r) => r.dataset.id === id)) selected.delete(id);
    if (!$$<HTMLButtonElement>('button[data-filter]').some((b) => b.dataset.filter === filter)) filter = 'all';
    paint();
  }).observe(section, { childList: true });
  // 「公开权限…」 in the 「文件」 list's menu: these files, selected here.
  window.addEventListener('rigel:access-select', (ev) => {
    const ids = (ev as CustomEvent<string[]>).detail ?? [];
    closeMenu();
    selected.clear();
    for (const id of ids) if (rows().some((r) => r.dataset.id === id)) selected.add(id);
    filter = 'all';
    paint();
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (selected.size === 0) toast(t('这些文件不在公开站的文件列表里（重复、被替换或在整体收藏包里）'));
  });
  paint();
}
