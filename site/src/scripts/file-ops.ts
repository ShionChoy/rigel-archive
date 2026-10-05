// What the 整理台 (scripts/desk.ts) and the 版本页's 「文件」 (scripts/edition-files.ts) share: the requests
// behind every file and folder action, one queue so that actions never overlap (a key pressed while the
// last action is still running waits for it instead of being lost), the last batch for 「撤销」, and
// renaming in place.
import { t } from './i18n';
import { confirmBox, conflictBox, toast } from './desk-ui';

export interface Reply {
  ok: boolean;
  msg?: string;
  err?: string;
  batch?: string | null;
  id?: string | null;
  [key: string]: unknown;
}

export async function postJson(path: string, body: unknown): Promise<Reply> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-request': '1' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Reply;
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

async function postForm(path: string, body: FormData): Promise<Reply> {
  const r = await fetch(path, { method: 'POST', body, headers: { accept: 'application/json', 'x-admin-request': '1' } }).catch(() => null);
  return ((await r?.json().catch(() => null)) as Reply | null) ?? { ok: false, err: t('操作失败') };
}

// ------------------------------------------------------------------------------------------ the last batch

let last: string | null = null;

/** The batch the latest action wrote (what Ctrl+Z / 「撤销」 undoes). */
export const lastBatch = () => last;

/** Show an action's message (with 「撤销」 when it changed something) and remember its batch. */
export function report(r: Reply) {
  last = r.batch ?? last;
  toast(String(r.msg ?? ''), { batch: r.batch ?? null });
}

// ------------------------------------------------------------------------------------------ one action at a time

let chain: Promise<unknown> = Promise.resolve();
let pending = 0;

/**
 * Run `work` after the actions before it. Pressing a key while an action is still running used to do
 * nothing at all; now it waits its turn (and says so).
 */
export function queued<T>(work: () => Promise<T>): Promise<T> {
  pending += 1;
  if (pending > 1) toast(t('等上一个操作完成后继续…'));
  const run = chain.then(work, work);
  chain = run.catch(() => undefined).finally(() => (pending -= 1));
  return run;
}

/** More actions are waiting after the running one (the page is fetched again only after the last). */
export const moreQueued = () => pending > 1;

// ------------------------------------------------------------------------------------------ requests

/**
 * A folder operation (/admin/desk/folder): asks about same-named folders and confirmations, shows a
 * failure. Null when it failed or the admin said no.
 */
export async function folderRequest(body: Record<string, unknown>): Promise<Reply | null> {
  let r = await postJson('/admin/desk/folder', body);
  if (!r.ok && Array.isArray(r.conflict)) {
    const mode = await conflictBox(r.conflict as string[]);
    if (!mode) return null;
    r = await postJson('/admin/desk/folder', { ...body, mode });
  }
  if (!r.ok && typeof r.confirm === 'string') {
    if (!(await confirmBox(r.confirm, typeof r.confirmLabel === 'string' ? r.confirmLabel : t('确定删除')))) return null;
    r = await postJson('/admin/desk/folder', { ...body, confirmed: true });
  }
  if (!r.ok) {
    toast(String(r.err ?? t('操作失败')), { error: true });
    return null;
  }
  return r;
}

/**
 * A file action (the 整理台's POST /admin/inbox): on these files (and the files still to organize in the
 * original folders `dirs`), or with `all` on every file the list at `search` (the 整理台's query string)
 * shows. Shows a failure; null then.
 */
export async function fileRequest(
  action: string, ids: string[], extra: Record<string, string> = {}, opts: { all?: boolean; search?: string; dirs?: string[] } = {},
): Promise<Reply | null> {
  const body = new FormData();
  body.append('action', action);
  if (opts.all) body.append('scope', 'filter');
  else {
    for (const id of ids) body.append('ids', id);
    for (const dir of opts.dirs ?? []) body.append('dirs', dir);
  }
  for (const [k, v] of Object.entries(extra)) body.append(k, v);
  const r = await postForm(`/admin/inbox${opts.search ?? ''}`, body);
  if (!r.ok) {
    toast(r.err ?? t('操作失败'), { error: true });
    return null;
  }
  return r;
}

/** Rename files ([id, new name]); the server keeps the original names and refuses clashes in a folder. */
export async function renameRequest(pairs: [string, string][]): Promise<Reply> {
  const body = new FormData();
  body.append('action', 'rename');
  for (const [id] of pairs) body.append('ids', id);
  body.append('names', JSON.stringify(pairs));
  return postForm('/admin/inbox', body);
}

/** Undo a batch (the latest action's when none is given), with its message. */
export async function undoRequest(which?: string | null): Promise<Reply> {
  const batch = which || last;
  if (!batch) {
    toast(t('没有可以撤销的操作'), { error: true });
    return { ok: false };
  }
  const body = new FormData();
  body.append('batch', batch);
  const r = await postForm('/admin/history', body);
  toast(r.ok ? r.msg ?? t('已撤销') : r.err ?? t('撤销失败'), { error: !r.ok });
  if (r.ok && batch === last) last = null;
  return r;
}

// ------------------------------------------------------------------------------------------ renaming in place

/**
 * Put a text box in place of `target` (a name in a row, a tile or the tree): the name without `ext`,
 * which stays. Enter or leaving the box keeps the new name, Esc cancels. Resolves with the new name, or
 * null when it was cancelled or left unchanged. `row` stops being draggable meanwhile (dragging would
 * take the text box's selection with it).
 */
export function renameInPlace(target: HTMLElement, opts: { value: string; ext?: string; label: string; row?: HTMLElement | null; allowEmpty?: boolean }): Promise<string | null> {
  const box = document.createElement('span');
  box.className = 'rename-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = opts.value;
  input.setAttribute('aria-label', opts.label);
  box.appendChild(input);
  if (opts.ext) {
    const tail = document.createElement('span');
    tail.className = 'muted';
    tail.textContent = opts.ext;
    box.appendChild(tail);
  }
  const wasHidden = target.hidden;
  const draggable = opts.row?.draggable ?? false;
  target.hidden = true;
  if (opts.row) opts.row.draggable = false;
  target.parentNode!.insertBefore(box, target.nextSibling);
  input.focus();
  input.select();
  return new Promise((resolve) => {
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      box.remove();
      target.hidden = wasHidden;
      if (opts.row) opts.row.draggable = draggable;
      resolve(save && value !== opts.value && (value || opts.allowEmpty) ? value : null);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}

/**
 * Ask for a new folder's name where it will appear, before anything is made: one step, one entry in the
 * history. `holder` is the row or tile the caller built for it; the text box goes into its
 * [data-name-slot] (or into it). Enter or leaving the box makes the folder, Esc cancels. Resolves with the
 * name, or null.
 */
export function nameNewFolder(host: Element, before: Element | null, holder: HTMLElement, value: string): Promise<string | null> {
  holder.classList.add('new-folder-name');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = value;
  input.setAttribute('aria-label', t('新文件夹名称'));
  (holder.querySelector('[data-name-slot]') ?? holder).appendChild(input);
  host.insertBefore(holder, before);
  holder.scrollIntoView({ block: 'nearest' });
  input.focus();
  input.select();
  return new Promise((resolve) => {
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      holder.remove();
      resolve(save && name ? name : null);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}
