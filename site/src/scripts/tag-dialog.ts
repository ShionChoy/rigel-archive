// The 整理台's 「编辑标签与封面…」 (E): one audio file's tags in Picard's three columns (标签 · 文件原值 ·
// 新值), edited in its edition's track list like on the edition page, and saved the same way (one batch).
// A file not in the list yet can get its row here.

import { t } from './i18n';
import type { EditorData } from './edition';

type Tags = Record<string, string[]>;
import { NUMBERS, esc, join, parse, same } from './tag-values';

interface Result { ok: boolean; msg?: string; batch?: string | null; err?: string }

async function getJson<T>(url: string): Promise<T | null> {
  const r = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
  return ((await r?.json().catch(() => null)) as T | null) ?? null;
}

/**
 * Open the dialog; resolves with the save's result (null when nothing was saved). It opens at once with
 * 「读取中…」 (two requests follow, in parallel when the page knows the file's edition); closing it
 * meanwhile cancels. Never on top of another dialog.
 */
export async function tagDialog(fileId: string, editionHint?: string | null): Promise<Result | null> {
  if (document.querySelector('dialog[open]')) return null;
  const d = document.createElement('dialog');
  d.className = 'dlg dlg-wide tag-dialog';
  d.innerHTML = `<form method="dialog"><h3>${esc(t('标签与封面'))}</h3><p class="muted">${esc(t('读取中…'))}</p>
    <div class="dlg-buttons"><button value="cancel">${esc(t('取消'))}</button></div></form>`;
  document.body.appendChild(d);
  d.showModal();
  let closed = false;
  d.addEventListener('close', () => (closed = true), { once: true });
  type View = { ok: boolean; err?: string; view?: { file: { id: string; name: string; edition_id: string | null }; row: { id: string } | null } };
  type Data = { ok: boolean; data?: EditorData; err?: string };
  const editorData = (id: string) => getJson<Data>(`/admin/editions/${id}/data`);
  const [view, early] = await Promise.all([
    getJson<View>(`/admin/desk/tags?file=${encodeURIComponent(fileId)}`),
    editionHint ? editorData(editionHint) : Promise.resolve(null),
  ]);
  const fail = (err: string): Result | null => {
    d.remove();
    return closed ? null : { ok: false, err };
  };
  if (closed) return fail('');
  if (!view?.ok || !view.view) return fail(view?.err ?? t('读取失败'));
  const edition = view.view.file.edition_id;
  if (!edition) return fail(t('先把文件放进某个版本：标签在版本的曲目表里编辑'));
  const res = edition === editionHint ? early : await editorData(edition);
  if (closed) return fail('');
  if (!res?.ok || !res.data) return fail(res?.err ?? t('读取失败'));
  const data = res.data;
  const rowId = view.view.row?.id ?? null;
  const labels = new Map(data.tagDefs.map((d) => [d.name, d.label]));
  const order = new Map(data.tagDefs.map((d, i) => [d.name, i]));
  const label = (n: string) => labels.get(n) ?? (n.startsWith('performer:') ? t('演奏者（{role}）', { role: n.slice(10) }) : n);
  const file = data.files[fileId];
  const original: Tags = file?.original ?? {};
  const row = rowId ? data.rows.find((r) => r.id === rowId) : undefined;
  const tags: Tags = structuredClone(row?.tags ?? {});
  const extra = new Set<string>();
  const values = (n: string) => (n in tags ? tags[n] : original[n] ?? []);
  const status = (n: string) => {
    const o = original[n] ?? [];
    const v = values(n);
    if (same(o, v)) return '';
    return o.length === 0 ? 'added' : v.length === 0 ? 'removed' : 'changed';
  };
  const setValues = (n: string, list: string[]) => {
    if (same(list, original[n] ?? [])) delete tags[n];
    else tags[n] = list;
  };
  // Re-drawing removes the focused input, whose blur may fire another change: one drawing at a time.
  let drawing = false;
  const draw = () => {
    if (drawing) return;
    drawing = true;
    try {
      drawNow();
    } finally {
      drawing = false;
    }
  };
  const drawNow = () => {
    if (d.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const names = [...new Set([...Object.keys(original).filter((k) => !NUMBERS.includes(k)), ...Object.keys(tags), ...data.display, ...extra])]
      .sort((a, b) => (order.get(a) ?? 1e4) - (order.get(b) ?? 1e4) || a.localeCompare(b));
    const addable = data.tagDefs.filter((x) => !names.includes(x.name) && !NUMBERS.includes(x.name));
    d.innerHTML = `<form method="dialog">
      <h3>${esc(t('标签与封面 · {name}', { name: file?.name ?? fileId }))}</h3>
      <p class="muted small">${esc(t('{edition} · 下载时写入文件的标签；文件本身不变。', { edition: `${data.edition.release} ${data.edition.label}` }))}
        <a href="/admin/editions/${esc(edition)}${rowId ? `#row=${esc(rowId)}` : ''}">${esc(t('在版本页编辑（全部曲目、封面）›'))}</a></p>
      ${row ? `<div class="tri-scroll"><table class="tri-table"><thead><tr><th>${esc(t('标签'))}</th><th>${esc(t('文件原值'))}</th><th>${esc(t('新值（下载时写入）'))}</th><th></th></tr></thead><tbody>
        ${names.map((n) => `<tr class="${status(n)}"><th>${esc(label(n))} <small class="muted">${esc(n)}</small></th>
          <td class="orig">${original[n]?.length ? esc(join(original[n])) : '<span class="muted">—</span>'}</td>
          <td class="new"><input data-tag="${esc(n)}" value="${esc(join(values(n)))}" /></td>
          <td class="acts">${n in tags ? `<button type="button" data-revert="${esc(n)}" title="${esc(t('恢复为文件原值'))}">↺</button>` : ''}${values(n).length ? `<button type="button" data-drop="${esc(n)}" title="${esc(t('删除这个标签'))}">×</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="tri-actions">
          <select data-add><option value="">${esc(t('＋ 添加标签…'))}</option>${addable.map((x) => `<option value="${esc(x.name)}">${esc(x.label)}</option>`).join('')}</select>
          <button type="button" data-revert-all ${Object.keys(tags).length ? '' : 'disabled'}>${esc(t('恢复为文件原值'))}</button>
          <span class="muted small">${esc(t('绿 = 新增 · 黄 = 改动 · 红 = 删除'))}</span>
        </p>`
      : `<p>${esc(t('这个文件还没有对应到曲目表里的一行，下载时只写入专辑层面的标签。'))}</p>`}
      <p class="err-line" data-err></p>
      <div class="dlg-buttons">
        <button value="cancel">${esc(t('取消'))}</button>
        ${row ? `<button value="ok" class="primary">${esc(t('保存'))}</button>` : `<button value="new" class="primary">${esc(t('为这个文件新建一行'))}</button>`}
      </div></form>`;
  };
  d.addEventListener('change', (e) => {
    const el = e.target as HTMLElement;
    const input = el.closest('[data-tag]') as HTMLInputElement | null;
    if (input) {
      setValues(input.dataset.tag!, parse(input.value));
      draw();
      (d.querySelector(`[data-tag="${CSS.escape(input.dataset.tag!)}"]`) as HTMLInputElement | null)?.focus();
    }
    const add = el.closest('[data-add]') as HTMLSelectElement | null;
    if (add?.value) {
      extra.add(add.value);
      draw();
      (d.querySelector(`[data-tag="${CSS.escape(add.value)}"]`) as HTMLInputElement | null)?.focus();
    }
  });
  d.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.revert) {
      delete tags[b.dataset.revert];
      draw();
    } else if (b.dataset.drop) {
      setValues(b.dataset.drop, []);
      draw();
    } else if (b.hasAttribute('data-revert-all')) {
      for (const k of Object.keys(tags)) delete tags[k];
      draw();
    }
  });
  d.addEventListener('keydown', (e) => {
    const input = (e.target as HTMLElement).closest('[data-tag]') as HTMLInputElement | null;
    if (input && e.key === 'Enter') {
      e.preventDefault();
      input.blur(); // commits the value (a change event), then the dialog is drawn again
    }
  });
  draw();
  for (;;) {
    if (!d.open) d.showModal();
    const choice = await new Promise<string>((resolve) => d.addEventListener('close', () => resolve(d.returnValue), { once: true }));
    if (choice !== 'ok' && choice !== 'new') {
      d.remove();
      return null;
    }
    const rows = data.rows.map((r) => ({ id: r.id, disc: r.disc, tags: r.id === rowId ? tags : r.tags, cover: r.cover }));
    if (choice === 'new') rows.push({ id: `new:${fileId}`, disc: data.rows.at(-1)?.disc ?? 1, tags: {}, cover: null });
    const r = await fetch(`/admin/editions/${edition}/tags`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-request': '1' }, body: JSON.stringify({ version: data.version, rows }),
    });
    const j = (await r.json().catch(() => ({ ok: false, err: t('保存失败') }))) as Result;
    if (j.ok) {
      d.remove();
      return j;
    }
    draw();
    (d.querySelector('[data-err]') as HTMLElement).textContent = j.err ?? t('保存失败');
  }
}
