// Pieces of the 整理台's interface that do not depend on its state: the right-click menu, the message at
// the bottom with 「撤销」, the small dialogs and the smart folder editor. scripts/desk.ts uses them.
import { t } from './i18n';

// ------------------------------------------------------------------------------------------ menu

export interface MenuItem {
  label: string;
  keys?: string; // shown on the right, e.g. «Ctrl+Shift+N»
  run?: () => void;
  disabled?: string | false; // why it cannot be used
  danger?: boolean;
  swatches?: { color: string; label: string; on: boolean; run: () => void }[];
}
export type MenuEntry = MenuItem | '-';

let menuClose: (() => void) | null = null;

export function closeMenu() {
  menuClose?.();
}

/** Show a menu at a point (viewport coordinates); arrows and Enter work in it, Esc and a click outside close it. */
export function openMenu(entries: MenuEntry[], x: number, y: number) {
  closeMenu();
  const menu = document.querySelector<HTMLElement>('#desk-menu')!;
  const list = entries.filter((e, i, all) => e !== '-' || (i > 0 && all[i - 1] !== '-' && i < all.length - 1));
  menu.innerHTML = '';
  const nodes = list.map((e) => {
      if (e === '-') {
        const hr = document.createElement('div');
        hr.className = 'sep';
        hr.setAttribute('role', 'separator');
        return hr;
      }
      if (e.swatches) {
        const row = document.createElement('div');
        row.className = 'menu-swatches';
        const label = document.createElement('span');
        label.textContent = e.label;
        row.appendChild(label);
        for (const s of e.swatches) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `swatch${s.on ? ' on' : ''}${s.color ? '' : ' none'}`;
          b.dataset.color = s.color;
          b.title = s.label;
          b.setAttribute('aria-label', s.label);
          b.addEventListener('click', () => {
            closeMenu();
            s.run();
          });
          row.appendChild(b);
        }
        return row;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (e.danger) b.classList.add('danger');
      const label = document.createElement('span');
      label.textContent = e.label;
      b.appendChild(label);
      if (e.keys) {
        const k = document.createElement('kbd');
        k.textContent = e.keys;
        b.appendChild(k);
      }
      if (e.disabled) {
        b.disabled = true;
        b.title = e.disabled;
      }
      b.addEventListener('click', () => {
        closeMenu();
        e.run?.();
      });
      return b;
    });
  for (const n of nodes) menu.appendChild(n);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
  buttons()[0]?.focus();
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMenu();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const all = buttons();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(at + (ev.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    }
  };
  const onDown = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) closeMenu();
  };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  addEventListener('blur', closeMenu);
  menuClose = () => {
    menu.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    removeEventListener('blur', closeMenu);
    menuClose = null;
  };
}

// ------------------------------------------------------------------------------------------ toast

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** The message at the bottom; with a batch it offers 「撤销」. */
export function toast(text: string, opts: { batch?: string | null; error?: boolean; onUndo?: (batch: string) => void } = {}) {
  const box = document.querySelector<HTMLElement>('#desk-toast');
  if (!box) return;
  clearTimeout(toastTimer);
  box.querySelector('[data-text]')!.textContent = text;
  box.classList.toggle('err', !!opts.error);
  const undo = box.querySelector<HTMLButtonElement>('[data-act="undo-toast"]')!;
  undo.hidden = !opts.batch;
  undo.dataset.batch = opts.batch ?? '';
  box.hidden = !text;
  if (!opts.error) toastTimer = setTimeout(() => (box.hidden = true), opts.batch ? 12000 : 6000);
}

// ------------------------------------------------------------------------------------------ dialogs

function show(dialog: HTMLDialogElement): Promise<string> {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    const done = () => {
      dialog.removeEventListener('close', done);
      resolve(dialog.returnValue);
    };
    dialog.addEventListener('close', done);
    dialog.showModal();
  });
}

export async function confirmBox(text: string, ok = t('确定')): Promise<boolean> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-confirm')!;
  d.querySelector('[data-text]')!.textContent = text;
  d.querySelector('[data-ok]')!.textContent = ok;
  return (await show(d)) === 'ok';
}

export async function conflictBox(names: string[]): Promise<'merge' | 'both' | null> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-conflict')!;
  d.querySelector('[data-text]')!.textContent = t('「{names}」在目标位置已经存在。合并：把里面的东西并到已有的文件夹里；两个都保留：移过去的改名加「(2)」。', { names: names.join('、') });
  const r = await show(d);
  return r === 'merge' || r === 'both' ? r : null;
}

export async function batchBox(under: string): Promise<string | null> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-batch')!;
  d.querySelector('[data-under]')!.textContent = t('在「{place}」里新建', { place: under });
  const area = d.querySelector<HTMLTextAreaElement>('textarea')!;
  area.value = '';
  const r = show(d);
  area.focus();
  return (await r) === 'ok' && area.value.trim() ? area.value : null;
}

export interface TypeChoice {
  type: 'era' | 'release' | 'edition';
  options: Record<string, string>;
}

/** 「设为名义、作品或版本」: `why` says for each type why it cannot be chosen here (empty = it can). */
export async function typeBox(
  name: string, why: Record<'era' | 'release' | 'edition', string>, guess: { catalog_no: string | null; title: string },
): Promise<TypeChoice | null> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-type')!;
  const form = d.querySelector('form')!;
  d.querySelector('[data-folder-name]')!.textContent = name;
  d.querySelector('[data-err]')!.textContent = '';
  const radios = [...form.querySelectorAll<HTMLInputElement>('input[name="type"]')];
  for (const r of radios) {
    const reason = why[r.value as keyof typeof why];
    r.disabled = !!reason;
    r.checked = false;
    d.querySelector(`[data-why="${r.value}"]`)!.textContent = reason ? `（${reason}）` : '';
  }
  const first = radios.find((r) => !r.disabled);
  if (first) first.checked = true;
  const input = (n: string) => form.elements.namedItem(n) as unknown as HTMLInputElement;
  input('catalog_no').value = guess.catalog_no ?? '';
  input('title').value = guess.title;
  input('name').value = name;
  const sync = () => {
    const type = radios.find((r) => r.checked)?.value;
    for (const box of d.querySelectorAll<HTMLElement>('[data-fields]')) box.hidden = box.dataset.fields !== type;
    (d.querySelector('[data-ok]') as HTMLButtonElement).disabled = !type;
    // 「＋ 新类型…」 and 「＋ 新形式…」 ask for the new one's name.
    const fresh = input('slot').value === '__new__';
    for (const el of d.querySelectorAll<HTMLElement>('[data-new-type]')) el.hidden = !fresh;
    const freshForm = input('form').value === '__new__';
    for (const el of d.querySelectorAll<HTMLElement>('[data-new-form]')) el.hidden = !freshForm;
  };
  form.addEventListener('change', sync);
  sync();
  const r = await show(d);
  form.removeEventListener('change', sync);
  const type = radios.find((x) => x.checked)?.value as TypeChoice['type'] | undefined;
  if (r !== 'ok' || !type) return null;
  const v = (n: string) => input(n).value;
  if (type === 'release') return { type, options: { catalog_no: v('catalog_no'), title: v('title'), form: v('form'), new_form: v('new_form') } };
  if (type === 'edition') return { type, options: { slot: v('slot'), new_type: v('new_type'), name: v('name') } };
  return { type, options: {} };
}

export function helpBox(onGuide: () => void) {
  const d = document.querySelector<HTMLDialogElement>('#dlg-help')!;
  show(d).then((r) => {
    if (r === 'guide') onGuide();
  });
}

/** The first-visit guide: four steps, each pointing at one part of the page. */
export function guideBox() {
  const d = document.querySelector<HTMLDialogElement>('#dlg-guide')!;
  const steps = [...d.querySelectorAll<HTMLElement>('[data-step]')];
  const targets = ['#desk-side', '#desk-content', '#desk-inspector', '#desk-main'];
  let at = 0;
  const next = d.querySelector<HTMLButtonElement>('[data-next]')!;
  const go = (i: number) => {
    at = i;
    steps.forEach((s, k) => (s.hidden = k !== i));
    document.querySelectorAll('.guide-focus').forEach((e) => e.classList.remove('guide-focus'));
    document.querySelector(targets[i])?.classList.add('guide-focus');
    next.textContent = i === steps.length - 1 ? t('开始整理') : t('下一步');
  };
  const onNext = () => (at < steps.length - 1 ? go(at + 1) : d.close('done'));
  next.addEventListener('click', onNext);
  go(0);
  show(d).then(() => {
    next.removeEventListener('click', onNext);
    document.querySelectorAll('.guide-focus').forEach((e) => e.classList.remove('guide-focus'));
    try {
      localStorage.setItem('rigel.deskGuide', '1');
    } catch {
      // private mode: the guide shows again next time
    }
  });
}

export async function previewBox(fileId: string, init: (root: Element) => void) {
  const d = document.querySelector<HTMLDialogElement>('#dlg-preview')!;
  const body = d.querySelector<HTMLElement>('[data-body]')!;
  body.innerHTML = `<p class="muted">${t('读取中…')}</p>`;
  d.showModal();
  const r = await fetch(`/admin/files/${fileId}/preview`);
  body.innerHTML = r.ok ? await r.text() : `<p class="muted">${t('读取失败（HTTP {status}）', { status: r.status })}</p>`;
  init(body);
  d.addEventListener('close', () => (body.innerHTML = ''), { once: true });
}

// ------------------------------------------------------------------------------------------ smart folder editor

export interface Rule {
  field: string;
  op: string;
  value?: string;
}
export interface RuleSet {
  match: 'all' | 'any';
  rules: Rule[];
}
interface Choice { id: string; label: string }
export interface EditorData {
  ruleFields: { id: string; label: string; ops: string[]; value: string }[];
  ruleOps: Record<string, string>;
  kinds: Choice[];
  rights: Choice[];
  states: Choice[];
  origins: Choice[];
  suggestKinds: Choice[];
  releases: Choice[];
  folders: { id: string; path: string }[];
}

/** Edit a smart folder's name and rules; resolves with them, or null when cancelled. `save` may refuse (returns an error text). */
export async function smartBox(data: EditorData, start: { name: string; rules: RuleSet } | null, save: (name: string, rules: RuleSet) => Promise<string | null>): Promise<boolean> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-smart')!;
  const form = d.querySelector('form')!;
  const box = d.querySelector<HTMLElement>('[data-rules]')!;
  const err = d.querySelector<HTMLElement>('[data-err]')!;
  d.querySelector('[data-title]')!.textContent = start ? t('编辑智能文件夹') : t('新建智能文件夹');
  const field = (name: string) => form.elements.namedItem(name) as unknown as HTMLInputElement;
  field('name').value = start?.name ?? '';
  field('match').value = start?.rules.match ?? 'all';
  err.textContent = '';
  const choicesFor = (kind: string): Choice[] | null => {
    if (kind === 'kind') return data.kinds;
    if (kind === 'rights') return data.rights;
    if (kind === 'state') return data.states;
    if (kind === 'origin') return data.origins;
    if (kind === 'suggest') return data.suggestKinds;
    if (kind === 'release') return data.releases;
    if (kind === 'folder') return data.folders.map((f) => ({ id: f.id, label: f.path }));
    return null;
  };
  const option = (value: string, label: string, selected: boolean) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = selected;
    return o;
  };
  const row = (rule: Rule) => {
    const div = document.createElement('div');
    div.className = 'rule-row';
    const fieldSelect = document.createElement('select');
    fieldSelect.dataset.part = 'field';
    for (const f of data.ruleFields) fieldSelect.appendChild(option(f.id, f.label, f.id === rule.field));
    const op = document.createElement('select');
    op.dataset.part = 'op';
    const valueBox = document.createElement('span');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '−';
    remove.title = t('删除这个条件');
    remove.setAttribute('aria-label', t('删除这个条件'));
    remove.addEventListener('click', () => div.remove());
    const fill = (keepValue: string | undefined) => {
      const spec = data.ruleFields.find((f) => f.id === fieldSelect.value)!;
      op.innerHTML = '';
      for (const o of spec.ops) op.appendChild(option(o, data.ruleOps[o] ?? o, o === rule.op));
      const choices = choicesFor(spec.value);
      let input: HTMLInputElement | HTMLSelectElement;
      if (choices) {
        input = document.createElement('select');
        for (const c of choices) input.appendChild(option(c.id, c.label, c.id === keepValue));
      } else {
        input = document.createElement('input');
        input.type = spec.value === 'number' ? 'number' : 'text';
        input.value = keepValue ?? '';
        if (spec.value === 'number') input.min = '0';
      }
      input.dataset.part = 'value';
      valueBox.innerHTML = '';
      if (spec.value !== 'none') valueBox.appendChild(input);
    };
    fieldSelect.addEventListener('change', () => fill(undefined));
    fill(rule.value);
    for (const el of [fieldSelect, op, valueBox, remove]) div.appendChild(el);
    return div;
  };
  box.innerHTML = '';
  for (const r of start?.rules.rules.length ? start.rules.rules : [{ field: 'name', op: 'contains', value: '' }]) box.appendChild(row(r));
  const add = d.querySelector<HTMLButtonElement>('[data-add-rule]')!;
  const onAdd = () => box.appendChild(row({ field: 'name', op: 'contains', value: '' }));
  add.addEventListener('click', onAdd);
  const read = (): RuleSet => ({
    match: field('match').value === 'any' ? 'any' : 'all',
    rules: [...box.querySelectorAll<HTMLElement>('.rule-row')].map((r) => {
      const get = (part: string) => r.querySelector<HTMLInputElement>(`[data-part="${part}"]`)?.value;
      return { field: get('field') ?? '', op: get('op') ?? '', value: get('value') };
    }),
  });
  return new Promise((resolve) => {
    const onSubmit = async (ev: SubmitEvent) => {
      if ((ev.submitter as HTMLButtonElement | null)?.value !== 'ok') return;
      ev.preventDefault();
      const problem = await save(field('name').value, read());
      if (problem) err.textContent = problem;
      else d.close('ok');
    };
    const onClose = () => {
      form.removeEventListener('submit', onSubmit);
      add.removeEventListener('click', onAdd);
      d.removeEventListener('close', onClose);
      resolve(d.returnValue === 'ok');
    };
    form.addEventListener('submit', onSubmit);
    d.addEventListener('close', onClose);
    d.returnValue = '';
    d.showModal();
  });
}

// ------------------------------------------------------------------------------------------ renaming files

export interface RenameFile {
  id: string;
  name: string; // as shown now
  stem: string; // without the extension
  ext: string; // «.flac» (kept), or '' when the name has none
  orig: string; // the name it was collected or uploaded with
}

/**
 * 「批量重命名」: replace text, a template ({name} = the name now, {n} = a number in list order), or back to
 * the original names; the new names are shown before anything changes. `save` may refuse (returns why).
 */
export async function renameBox(files: RenameFile[], save: (pairs: [string, string][]) => Promise<string | null>): Promise<boolean> {
  const d = document.querySelector<HTMLDialogElement>('#dlg-rename')!;
  const form = d.querySelector('form')!;
  const field = (name: string) => form.elements.namedItem(name) as unknown as HTMLInputElement;
  const preview = d.querySelector<HTMLElement>('[data-preview]')!;
  const count = d.querySelector<HTMLElement>('[data-count]')!;
  const err = d.querySelector<HTMLElement>('[data-err]')!;
  const ok = d.querySelector<HTMLButtonElement>('[data-ok]')!;
  d.querySelector('[data-title]')!.textContent = t('批量重命名 {n} 个文件', { n: files.length });
  field('find').value = '';
  field('replace').value = '';
  field('template').value = '{name}';
  field('start').value = '1';
  field('digits').value = String(Math.max(2, String(files.length).length));
  form.querySelector<HTMLInputElement>('input[name="mode"][value="replace"]')!.checked = true;
  err.textContent = '';
  const mode = () => form.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? 'replace';
  const next = (): [RenameFile, string][] => {
    const m = mode();
    const start = Math.max(0, Math.floor(Number(field('start').value) || 0));
    const digits = Math.min(6, Math.max(1, Math.floor(Number(field('digits').value) || 1)));
    const find = field('find').value;
    return files.map((f, i) => {
      if (m === 'restore') return [f, f.orig];
      const stem = m === 'template'
        ? field('template').value.split('{name}').join(f.stem).split('{n}').join(String(start + i).padStart(digits, '0'))
        : find ? f.stem.split(find).join(field('replace').value) : f.stem;
      return [f, stem.trim() + f.ext];
    });
  };
  const bad = /[\\/:*?"<>|]/;
  const render = () => {
    for (const box of d.querySelectorAll<HTMLElement>('[data-fields]')) box.hidden = box.dataset.fields !== mode();
    const list = next();
    const changed = list.filter(([f, n]) => n !== f.name);
    const problem = list.find(([f, n]) => n === f.ext || !n.trim())
      ? t('新文件名不能为空')
      : list.find(([, n]) => bad.test(n)) ? t('文件名不能包含 \\ / : * ? " < > |') : '';
    count.textContent = t('将改名 {n} 个（共 {total} 个）', { n: changed.length, total: files.length });
    err.textContent = problem;
    ok.disabled = !!problem || changed.length === 0;
    const table = document.createElement('table');
    table.className = 'keys rename-list';
    for (const [f, n] of list.slice(0, 200)) {
      const tr = document.createElement('tr');
      if (n === f.name) tr.className = 'same';
      for (const text of [f.name, '→', n]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    preview.replaceChildren(table);
  };
  form.addEventListener('input', render);
  render();
  return new Promise((resolve) => {
    const onSubmit = async (ev: SubmitEvent) => {
      if ((ev.submitter as HTMLButtonElement | null)?.value !== 'ok') return;
      ev.preventDefault();
      ok.disabled = true;
      const pairs = next().filter(([f, n]) => n !== f.name).map(([f, n]) => [f.id, n] as [string, string]);
      const problem = await save(pairs);
      ok.disabled = false;
      if (problem) err.textContent = problem;
      else d.close('ok');
    };
    const onClose = () => {
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('input', render);
      d.removeEventListener('close', onClose);
      resolve(d.returnValue === 'ok');
    };
    form.addEventListener('submit', onSubmit);
    d.addEventListener('close', onClose);
    d.returnValue = '';
    d.showModal();
    field('find').focus();
  });
}

// ------------------------------------------------------------------------------------------ tags and covers
