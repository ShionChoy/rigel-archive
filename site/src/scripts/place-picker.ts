// 「移动到…」: pick a place in the archive tree (components/PlacePicker.astro). Search matches every word
// against the place's full path; the last five places used come first.

import { t } from './i18n';

interface Option {
  key: string;
  path: string;
  kind: string; // era, rel, ed, fd, top
  depth: number;
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
const placeable = (o: Option) => o.kind !== 'era' && o.kind !== 'top';

let options: Option[] | null = null;

export function pickerOptions(): Option[] {
  if (!options) {
    const raw = document.querySelector('#place-picker [data-options]')?.textContent ?? '[]';
    options = (JSON.parse(raw) as Option[]).map((o) => ({ ...o, folded: fold(o.path) }) as Option);
  }
  return options;
}

export function placePath(key: string): string {
  return pickerOptions().find((o) => o.key === key)?.path ?? key;
}

export function openPicker(opts: PickOptions = {}): Promise<PickResult | null> {
  const dialog = document.querySelector<HTMLDialogElement>('#place-picker');
  if (!dialog) return Promise.resolve(null);
  const all = pickerOptions();
  const search = dialog.querySelector<HTMLInputElement>('[data-search]')!;
  const list = dialog.querySelector<HTMLUListElement>('[data-list]')!;
  const ok = dialog.querySelector<HTMLButtonElement>('[data-ok]')!;
  const newFolder = dialog.querySelector<HTMLInputElement>('[data-new-folder]')!;
  const keepRow = dialog.querySelector<HTMLElement>('[data-keep-row]')!;
  const keep = dialog.querySelector<HTMLInputElement>('[data-keep]')!;
  const chosenText = dialog.querySelector<HTMLElement>('[data-chosen]')!;
  dialog.querySelector('[data-title]')!.textContent = opts.title ?? t('移动到…');
  ok.textContent = opts.confirm ?? t('移动到这里');
  search.value = '';
  newFolder.value = '';
  keepRow.hidden = !opts.keepDir;
  keep.checked = false;
  dialog.querySelector('[data-keep-label]')!.textContent = opts.keepDir ? t('保留「{dir}」下的子文件夹结构', { dir: opts.keepDir }) : '';
  let chosen: Option | null = null;
  let shown: Option[] = [];

  const allowed = (o: Option) => !opts.exclude?.(o.key);
  const update = () => {
    const canFile = !!chosen && (placeable(chosen) || newFolder.value.trim() !== '');
    ok.disabled = !canFile;
    chosenText.textContent = chosen
      ? `${chosen.path}${newFolder.value.trim() ? ` / ${newFolder.value.trim()}` : ''}${!placeable(chosen) && !newFolder.value.trim() ? ` — ${t('名义和顶层只能放文件夹，请输入新文件夹名')}` : ''}`
      : t('请选择位置');
  };
  const render = () => {
    const words = fold(search.value).split(/\s+/).filter(Boolean);
    if (words.length) {
      shown = all
        .filter((o) => allowed(o) && words.every((w) => (o as Option & { folded: string }).folded.includes(w)))
        .sort((a, b) => a.depth - b.depth || a.path.length - b.path.length)
        .slice(0, 200);
    } else {
      const recent = recentPlaces().map((k) => all.find((o) => o.key === k)).filter((o): o is Option => !!o && allowed(o));
      shown = [...recent, ...all.filter((o) => allowed(o) && !recent.includes(o))];
    }
    const recentCount = words.length ? 0 : recentPlaces().length;
    list.replaceChildren(
      ...shown.map((o, i) => {
        const li = document.createElement('li');
        li.role = 'option';
        li.dataset.key = o.key;
        li.className = `k-${o.kind}${o === chosen ? ' chosen' : ''}${i < recentCount ? ' recent' : ''}`;
        if (words.length || i < recentCount) li.textContent = o.path;
        else {
          li.textContent = o.path.split(' / ').at(-1) ?? o.path;
          li.style.paddingLeft = `${8 + o.depth * 14}px`;
          li.title = o.path;
        }
        li.setAttribute('aria-selected', String(o === chosen));
        return li;
      }),
    );
    update();
  };
  const choose = (o: Option | null) => {
    chosen = o;
    list.querySelectorAll('li').forEach((li) => {
      const on = li.dataset.key === o?.key;
      li.classList.toggle('chosen', on);
      li.setAttribute('aria-selected', String(on));
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    update();
  };

  return new Promise((resolve) => {
    const onClick = (e: Event) => {
      const li = (e.target as HTMLElement).closest('li');
      if (!li) return;
      choose(shown.find((o) => o.key === li.dataset.key) ?? null);
      if ((e as MouseEvent).detail === 2 && !ok.disabled) {
        dialog.returnValue = 'ok';
        dialog.close('ok');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      if (e.key === 'Enter') {
        if ((e.target as HTMLElement) === search && !chosen && shown[0]) choose(shown[0]);
        if (!ok.disabled) {
          e.preventDefault();
          dialog.close('ok');
        } else e.preventDefault();
        return;
      }
      e.preventDefault();
      const at = chosen ? shown.indexOf(chosen) : -1;
      const next = e.key === 'ArrowDown' ? Math.min(shown.length - 1, at + 1) : Math.max(0, at - 1);
      choose(shown[next] ?? null);
    };
    const onClose = () => {
      list.removeEventListener('click', onClick);
      dialog.removeEventListener('keydown', onKey);
      search.removeEventListener('input', render);
      newFolder.removeEventListener('input', update);
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue === 'ok' && chosen) {
        rememberPlace(chosen.key);
        resolve({ target: chosen.key, newFolder: newFolder.value.trim(), keep: keep.checked });
      } else resolve(null);
    };
    list.addEventListener('click', onClick);
    dialog.addEventListener('keydown', onKey);
    search.addEventListener('input', render);
    newFolder.addEventListener('input', update);
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    render();
    dialog.showModal();
    search.focus();
  });
}
