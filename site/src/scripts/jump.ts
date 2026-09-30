// Ctrl+K (⌘K) on every admin page: type a few letters, arrows to choose, Enter to go (pages/admin/jump.ts).
import { t } from './i18n';

interface Item { kind: string; label: string; sub?: string; href: string }

export function initJump() {
  const d = document.querySelector<HTMLDialogElement>('#jump');
  if (!d) return;
  const input = d.querySelector<HTMLInputElement>('input')!;
  const list = d.querySelector<HTMLUListElement>('ul')!;
  let items: Item[] = [];
  let at = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token = 0;

  const draw = () => {
    list.replaceChildren(...items.map((item, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === at));
      const kind = Object.assign(document.createElement('span'), { className: 'chip', textContent: item.kind });
      const label = Object.assign(document.createElement('span'), { className: 'jump-label', textContent: item.label });
      li.appendChild(kind);
      li.appendChild(label);
      if (item.sub) li.appendChild(Object.assign(document.createElement('span'), { className: 'muted small jump-sub', textContent: item.sub }));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        go(i);
      });
      return li;
    }));
    if (!items.length && input.value.trim()) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: t('没有找到') }));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const search = async () => {
    const q = input.value.trim();
    const mine = ++token;
    if (!q) {
      items = [];
      draw();
      return;
    }
    const r = await fetch(`/admin/jump?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { items?: Item[] } | null;
    if (mine !== token) return;
    items = j?.items ?? [];
    at = 0;
    draw();
  };
  const go = (i: number) => {
    const item = items[i];
    if (!item) return;
    d.close();
    location.href = item.href;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (input.value.trim() && !items.length) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: t('搜索中…') }));
    timer = setTimeout(search, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(at);
    } else if (e.key === 'Escape') {
      // A search box clears itself on the first Esc; here Esc closes at once.
      e.preventDefault();
      d.close();
    }
  });
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close(); // a click outside the box
  });
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return;
    if (document.querySelector('dialog[open]') && !d.open) return;
    e.preventDefault();
    if (d.open) return;
    input.value = '';
    items = [];
    draw();
    d.showModal();
    input.focus();
  }, true);
}
