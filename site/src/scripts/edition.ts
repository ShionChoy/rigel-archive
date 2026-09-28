// The edition page's tag editor (版本页). Everything is edited on the page and kept here until 「保存」,
// which sends the whole track list in one request (one entry in the history, undone with one 「撤销」).
//
//   版本信息  the tags the tracks share, for all tracks or the selected ones: one value when they agree,
//            «‹ 保持不变 · 15 首中 2 种值 ›» when they differ (left alone unless a new value is typed)
//   封面      the covers the tracks end up with (their own, or one chosen), 「更换封面…」
//   曲目列表  one row per track: chosen columns edited in place; a row opens into Picard's three columns
//            (标签 · 文件原值 · 新值), green = added, yellow = changed, red = removed
//
// A row's tags are what it sets over its file's own (文件原值): typing the file's own value back removes
// the override, 「恢复为文件原值」 removes them all.

import { t } from './i18n';

type Tags = Record<string, string[]>;
interface Cover { file?: string; picture?: string; mode: 'replace' | 'add' }
interface EdFile {
  id: string; name: string; ext: string; spec: string; duration: number | null; track_id: string | null; cover: string | null;
  original: Tags; read: boolean; lossless: boolean; path: string;
}
interface EdRow { id: string; disc: number; position: number; track_id: string; entry_title: string; duration_ms: number | null; tags: Tags; cover: Cover | null; files: string[] }
interface EdPicture { key: string; src: string; full: string; label: string; width: number | null; height: number | null; mime: string; size: number; embeddable: boolean; tracks: number; kind: 'file' | 'embedded' }
export interface EditorData {
  edition: { id: string; label: string; release: string; search: string };
  version: string;
  rows: EdRow[];
  files: Record<string, EdFile>;
  unlinked: string[];
  pictures: EdPicture[];
  display: string[];
  tagDefs: { name: string; label: string; group: string }[];
  unread: number;
}

interface Row { id: string; disc: number; tags: Tags; cover: Cover | null; entry: string; duration: number | null; title?: string }

const NUMBERS = ['tracknumber', 'totaltracks', 'discnumber', 'totaldiscs'];
const PERFORMER = 'performer:';
const COLUMNS_KEY = 'rigel.edColumns';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// The Workers types clash with the DOM's ParentNode here; these take any element.
const $ = <E = HTMLElement>(sel: string, root: unknown = document) => (root as ParentNode).querySelector(sel) as unknown as E | null;
const same = (a: string[] | undefined, b: string[] | undefined) => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const join = (v: string[] | undefined) => (v ?? []).join('; ');
const parse = (text: string) => [...new Set(text.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean))];
const clock = (s: number | null | undefined) => {
  if (!s) return '';
  const r = Math.round(s);
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const sec = String(r % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const size = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

export function initEditor(data: EditorData) {
  const defs = new Map(data.tagDefs.map((d) => [d.name, d]));
  const order = new Map(data.tagDefs.map((d, i) => [d.name, i]));
  const pictures = () => new Map(data.pictures.map((p) => [p.key, p]));
  const label = (name: string) => defs.get(name)?.label ?? (name.startsWith(PERFORMER) ? t('演奏者（{role}）', { role: name.slice(PERFORMER.length) }) : name);
  const sortNames = (names: Iterable<string>) => {
    const rank = (n: string) => order.get(n) ?? (n.startsWith(PERFORMER) ? 1e4 : 2e4);
    return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  };

  // ------------------------------------------------------------------ state
  let rows: Row[] = data.rows.map((r) => ({ id: r.id, disc: r.disc, tags: structuredClone(r.tags), cover: r.cover, entry: r.entry_title, duration: r.duration_ms }));
  const baseFiles = new Map(data.rows.map((r) => [r.id, r.files]));
  const links = new Map<string, string | null>(); // file → row it is linked to on this page (null: none)
  const selected = new Set<string>();
  const expanded = new Set<string>();
  const shown = new Set<string>(); // names added to the display on this page
  const rowShown = new Map<string, Set<string>>(); // names added to one row's panel
  let blank = 0;
  let columns: string[] = ['title', 'artist', 'composer'];
  try {
    const saved = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.every((x) => typeof x === 'string')) columns = saved;
  } catch {
    // default columns
  }
  const snapshot = () => JSON.stringify({ rows: rows.map((r) => [r.id, r.disc, r.tags, r.cover]), links: [...links] });
  let initial = snapshot();

  const filesOf = (row: Row): string[] => {
    const own = (baseFiles.get(row.id) ?? (row.id.startsWith('new:') ? [row.id.slice(4)] : [])).filter((f) => (links.has(f) ? links.get(f) === row.id : true));
    const added = [...links].filter(([f, r]) => r === row.id && !own.includes(f)).map(([f]) => f);
    const rank = (id: string) => ((data.files[id]?.lossless ? 0 : 2) + (data.files[id]?.ext === 'flac' ? 0 : 1));
    return [...own, ...added].sort((a, b) => rank(a) - rank(b));
  };
  const mainFile = (row: Row) => data.files[filesOf(row)[0] ?? ''];
  const original = (row: Row): Tags => mainFile(row)?.original ?? {};
  const values = (row: Row, name: string): string[] => (name in row.tags ? row.tags[name] : original(row)[name] ?? []);
  const setValues = (row: Row, name: string, list: string[]) => {
    if (same(list, original(row)[name] ?? [])) delete row.tags[name];
    else row.tags[name] = list;
  };
  const status = (row: Row, name: string): string => {
    const o = original(row)[name] ?? [];
    const v = values(row, name);
    if (same(o, v)) return '';
    if (o.length === 0) return 'added';
    if (v.length === 0) return 'removed';
    return 'changed';
  };
  const numbers = () => {
    const out = new Map<string, { pos: number; total: number }>();
    const discs = new Set(rows.map((r) => r.disc));
    for (const d of discs) {
      const list = rows.filter((r) => r.disc === d);
      list.forEach((r, i) => out.set(r.id, { pos: i + 1, total: list.length }));
    }
    return { of: out, discs: discs.size };
  };
  const scope = () => (selected.size ? rows.filter((r) => selected.has(r.id)) : rows);

  // ------------------------------------------------------------------ 查找元数据: comparing with an online release
  interface OnlineTrack { disc: number; position: number; title: string; duration_ms: number | null; tags: Tags }
  interface OnlineCover { url: string; large: string; thumb: string; source: string }
  interface Online { source: 'musicbrainz' | 'bandcamp'; id: string; url: string; label: string; cover: OnlineCover | null; album: Tags; tracks: OnlineTrack[] }
  interface CoverInfo { width: number; height: number; mime: string; size: number | null }
  /**
   * The release being compared: which online track each row is, what was turned down, whether its cover is
   * wanted, and its cover's size (undefined while it is being read).
   */
  let compare: {
    online: Online; mapping: Map<string, number | null>; rejected: Set<string>; cover: boolean; coverInfo?: CoverInfo | { err: string };
  } | null = null;
  let editionIds: Record<string, string> | null = null; // the source's id, kept with the edition when its data was taken
  const durationOf = (r: Row): number | null => (r.duration ? r.duration / 1000 : mainFile(r)?.duration ?? null);
  const onlineOf = (row: Row): OnlineTrack | null => {
    const i = compare?.mapping.get(row.id);
    return i == null ? null : compare!.online.tracks[i] ?? null;
  };
  /** The value the online release has for a row's tag, when it differs and was not turned down. */
  const proposal = (row: Row, name: string): string[] | null => {
    if (!compare || NUMBERS.includes(name)) return null;
    const o = onlineOf(row);
    if (!o) return null;
    const v = o.tags[name] ?? compare.online.album[name];
    if (!v?.length || same(v, values(row, name)) || compare.rejected.has(`${row.id}|${name}`)) return null;
    return v;
  };
  const onlineNames = (): string[] => (compare ? sortNames([...Object.keys(compare.online.album), ...compare.online.tracks.flatMap((x) => Object.keys(x.tags))]) : []);
  const proposalCount = () => rows.reduce((n, r) => n + onlineNames().filter((name) => proposal(r, name)).length, 0);
  const titleKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  /** Rows to online tracks: by order when the lengths agree, else by title, else by a length within 2 s. */
  function autoMap(online: Online): Map<string, number | null> {
    const out = new Map<string, number | null>();
    const used = new Set<number>();
    rows.forEach((r, i) => {
      const t = online.tracks[i];
      const d = durationOf(r);
      if (t && (!d || !t.duration_ms || Math.abs(d * 1000 - t.duration_ms) <= 3000 || titleKey(join(values(r, 'title'))) === titleKey(t.title))) {
        out.set(r.id, i);
        used.add(i);
      }
    });
    for (const r of rows) {
      if (out.has(r.id)) continue;
      const title = titleKey(join(values(r, 'title')) || r.entry);
      let j = online.tracks.findIndex((t, k) => !used.has(k) && titleKey(t.title) === title);
      if (j < 0) {
        const d = durationOf(r);
        const near = d ? online.tracks.map((t, k) => [t, k] as const).filter(([t, k]) => !used.has(k) && t.duration_ms && Math.abs(t.duration_ms - d * 1000) <= 2000) : [];
        if (near.length === 1) j = near[0][1];
      }
      out.set(r.id, j >= 0 ? j : null);
      if (j >= 0) used.add(j);
    }
    return out;
  }
  function takeAll() {
    if (!compare) return;
    for (const r of rows) for (const name of onlineNames()) {
      const v = proposal(r, name);
      if (v) setValues(r, name, v);
    }
    remember();
  }
  /** Taking a release's data also records its id on the edition (归档信息 → 外部链接). */
  function remember() {
    if (!compare) return;
    editionIds = compare.online.source === 'musicbrainz' ? { musicbrainz_release: compare.online.id } : { bandcamp: compare.online.url };
  }
  const coverKey = (row: Row): string | null => {
    if (row.cover) return row.cover.file ? `file:${row.cover.file}` : `picture:${row.cover.picture}`;
    const f = mainFile(row);
    return f?.cover ? `picture:${f.cover}` : null;
  };
  const unlinked = (): string[] => {
    const linked = new Set(rows.flatMap((r) => filesOf(r)));
    return Object.keys(data.files).filter((f) => !linked.has(f));
  };
  const changes = (): number => {
    if (snapshot() === initial) return 0;
    const before = new Map(data.rows.map((r) => [r.id, JSON.stringify([r.disc, r.tags, r.cover])]));
    let n = 0;
    const now = new Set(rows.map((r) => r.id));
    rows.forEach((r, i) => {
      const b = before.get(r.id);
      if (!b || b !== JSON.stringify([r.disc, r.tags, r.cover]) || data.rows[i]?.id !== r.id) n += 1;
    });
    for (const r of data.rows) if (!now.has(r.id)) n += 1;
    return n + links.size;
  };

  // ------------------------------------------------------------------ 版本信息
  const info = $('#ed-info')!;
  const coverBox = $('#ed-cover')!;
  const tracks = $('#tracks')!;

  function albumNames(list: Row[]): string[] {
    const names = new Set<string>([...data.display, ...shown]);
    for (const r of list) {
      for (const [k, v] of Object.entries(original(r))) if (v.length) names.add(k);
      for (const [k, v] of Object.entries(r.tags)) if (v.length || k in original(r)) names.add(k);
    }
    return sortNames([...names].filter((n) => n !== 'title' && !NUMBERS.includes(n)));
  }

  function renderInfo() {
    const list = scope();
    const n = numbers();
    const names = compare ? sortNames([...albumNames(list), ...onlineNames().filter((n) => n !== 'title' && list.some((r) => proposal(r, n)))]) : albumNames(list);
    const fields = names.map((name) => {
      const distinct = new Map<string, number>();
      for (const r of list) distinct.set(join(values(r, name)), (distinct.get(join(values(r, name))) ?? 0) + 1);
      const keep = distinct.size > 1;
      const value = keep ? '' : [...distinct.keys()][0] ?? '';
      const states = list.map((r) => status(r, name)).filter(Boolean);
      const st = states.includes('changed') ? 'changed' : states.includes('added') ? 'added' : states.includes('removed') ? 'removed' : '';
      const any = list.some((r) => values(r, name).length || name in r.tags);
      const holder = keep
        ? t('‹ 保持不变 · {n} 首中 {k} 种值 ›', { n: list.length, k: [...distinct.keys()].filter(Boolean).length + (distinct.has('') ? 1 : 0) })
        : t('（空）');
      // The online value, when every track that has one gets the same.
      const props = list.map((r) => proposal(r, name)).filter((v): v is string[] => !!v);
      const prop = props.length && props.every((v) => same(v, props[0])) ? props[0] : null;
      const propHtml = prop ? `<div class="prop"><span class="was">${esc(value || (keep ? t('各曲目不同') : t('（空）')))}</span> → <span class="will">${esc(join(prop))}</span>
          <button type="button" data-accept="${esc(name)}" title="${esc(t('采用'))}">✓</button><button type="button" data-reject="${esc(name)}" title="${esc(t('不采用'))}">✕</button></div>` : '';
      return `<label for="al-${esc(name)}">${esc(label(name))}</label>
        <div class="tf-wrap">
        ${propHtml}
        <div class="tf ${st} ${keep ? 'keep' : ''} ${prop ? 'has-prop' : ''}" title="${esc(name)}">
          <input id="al-${esc(name)}" data-album="${esc(name)}" value="${esc(value)}" placeholder="${esc(holder)}" autocomplete="off" />
          ${keep ? `<button type="button" class="tf-btn" data-values="${esc(name)}" title="${esc(t('各曲目的值'))}">▾</button>` : ''}
          ${any ? `<button type="button" class="tf-btn tf-x" data-remove="${esc(name)}" title="${esc(t('从这些曲目删除这个标签'))}">×</button>` : ''}
        </div></div>`;
    });
    const where = selected.size
      ? `${t('所选 {n} 首', { n: selected.size })} · <button type="button" class="linkish" data-act="clear-selection">${esc(t('取消选择'))}</button>`
      : t('改这里 = 改本版全部 {n} 首', { n: rows.length });
    if (rows.length === 0) {
      info.innerHTML = `<h2>${esc(t('版本信息'))} <small class="muted">${esc(t('写入文件的标签'))}</small></h2>
        <p class="muted">${esc(t('先在下面生成或新建曲目表，这里就会显示各曲目共同的标签（专辑、艺术家、日期……），改这里就是改全部曲目。'))}</p>`;
      return;
    }
    info.innerHTML = `
      <h2>${esc(t('版本信息'))} <small class="muted">${esc(t('写入文件的标签'))} · ${where}</small></h2>
      <p class="muted small">${esc(t('虚线格子表示各曲目的值不同：不动它就各自保持原样，填入新值则全部统一。清空一个格子 = 从这些曲目删除这个标签。'))}</p>
      ${data.unread ? `<p class="note small">${esc(t('还有 {n} 个文件的原有标签没读取完，稍后刷新页面即可看到「文件原值」。', { n: data.unread }))}</p>` : ''}
      <div class="album-grid">
        ${fields.join('')}
        <label>${esc(t('碟 / 曲'))}</label>
        <div class="tf-wrap"><div class="tf ro"><input value="${esc(t('{d} 碟 · {n} 首（按曲目列表自动）', { d: n.discs || 1, n: rows.length }))}" disabled /></div></div>
      </div>
      <p class="album-actions">
        <button type="button" data-act="add-tag">${esc(t('＋ 添加标签'))}</button>
        <button type="button" data-act="display">${esc(t('显示哪些标签…'))}</button>
        <span class="muted small">${esc(t('常用标签即使为空也显示；其余的添加后才显示。'))}</span>
      </p>`;
  }

  info.addEventListener('change', (e) => {
    const input = (e.target as HTMLElement).closest('[data-album]') as HTMLInputElement | null;
    if (!input) return;
    const name = input.dataset.album!;
    const list = parse(input.value);
    const box = input.closest('.tf');
    if (box?.classList.contains('keep') && list.length === 0) return; // left as each track has it
    for (const r of scope()) setValues(r, name, list);
    render({ keep: `al-${name}` });
  });
  info.addEventListener('keydown', (e) => {
    const input = (e.target as HTMLElement).closest('[data-album]') as HTMLInputElement | null;
    if (input && e.key === 'Enter') {
      pendingFocus = input.id;
      input.blur(); // commits the value (a change event); the field gets the focus back after drawing
    }
  });
  info.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const remove = el.closest('[data-remove]') as HTMLElement | null;
    if (remove) {
      for (const r of scope()) setValues(r, remove.dataset.remove!, []);
      render();
      return;
    }
    const accept = el.closest('[data-accept]') as HTMLElement | null;
    const reject = el.closest('[data-reject]') as HTMLElement | null;
    if (accept || reject) {
      const name = (accept ?? reject)!.dataset[accept ? 'accept' : 'reject']!;
      for (const r of scope()) {
        const v = proposal(r, name);
        if (!v) continue;
        if (accept) setValues(r, name, v);
        else compare?.rejected.add(`${r.id}|${name}`);
      }
      if (accept) remember();
      render();
      return;
    }
    const vals = el.closest('[data-values]') as HTMLElement | null;
    if (vals) {
      showValues(vals, vals.dataset.values!);
      return;
    }
    const act = (el.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'clear-selection') {
      selected.clear();
      render();
    } else if (act === 'add-tag') addTag(null);
    else if (act === 'display') displayDialog();
  });

  /** The different values of a tag across the scope, each with how many tracks; one chosen goes to all. */
  function showValues(anchor: HTMLElement, name: string) {
    document.querySelector('.tf-menu')?.remove();
    const counts = new Map<string, number>();
    for (const r of scope()) counts.set(join(values(r, name)), (counts.get(join(values(r, name))) ?? 0) + 1);
    const menu = document.createElement('div');
    menu.className = 'tf-menu';
    menu.innerHTML = [...counts].sort((a, b) => b[1] - a[1]).map(([v, n]) =>
      `<button type="button" data-v="${esc(v)}"><span>${v ? esc(v) : `<i class="muted">${esc(t('（空）'))}</i>`}</span><span class="muted">${esc(t('{n} 首', { n }))}</span></button>`).join('')
      + `<p class="muted small">${esc(t('点一个值，本范围的全部曲目都改成它'))}</p>`;
    anchor.closest('.tf')!.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-v]') as HTMLElement | null;
      if (!b) return;
      for (const r of scope()) setValues(r, name, parse(b.dataset.v!));
      menu.remove();
      render();
    });
    setTimeout(() => document.addEventListener('click', function off(ev) {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('click', off);
      }
    }), 0);
  }

  // ------------------------------------------------------------------ 封面
  const picSpec = (p: { width: number | null; height: number | null; mime: string; size: number | null }) =>
    [p.width && p.height ? `${p.width} × ${p.height}` : '', p.mime.replace('image/', '').toUpperCase(), p.size ? size(p.size) : ''].filter(Boolean).join(' · ');

  /** The cover most tracks end up with (of the tracks being compared, when comparing). */
  function mainCover(): EdPicture | null {
    const compared = compare ? rows.filter((r) => compare!.mapping.get(r.id) != null) : [];
    const counts = new Map<string, number>();
    for (const r of compared.length ? compared : rows) {
      const k = coverKey(r);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return best ? pictures().get(best) ?? null : null;
  }

  /** Which cover is larger: the online one being compared, or the one the tracks have now. */
  function coverVerdict(info: CoverInfo, local: EdPicture | null): { text: string; better: 'online' | 'local' | 'same' | 'unknown' } {
    if (!local) return { text: t('本地还没有封面'), better: 'online' };
    if (!local.width || !local.height || !info.width) return { text: t('尺寸未知，无法比较'), better: 'unknown' };
    const a = Math.max(info.width, info.height);
    const b = Math.max(local.width, local.height);
    if (a > b) return { text: t('在线的更大：长边 {a} px，本地 {b} px', { a, b }), better: 'online' };
    if (a < b) return { text: t('本地的更大：长边 {b} px，在线 {a} px，一般不必采用在线封面', { a, b }), better: 'local' };
    return { text: t('尺寸相同（长边 {a} px）：可以打开两张图对比画质和文件大小', { a }), better: 'same' };
  }

  /** The online cover's size and how it compares, as HTML (the compare bar and the 封面 panel show it). */
  function onlineCoverText(): { spec: string; verdict: string } {
    const info = compare?.coverInfo;
    if (!info) return { spec: esc(t('正在读取尺寸…')), verdict: '' };
    if ('err' in info) return { spec: `<span class="err-line">${esc(info.err)}</span>`, verdict: '' };
    const v = coverVerdict(info, mainCover());
    return { spec: `<b>${esc(picSpec(info))}</b>`, verdict: `<span class="cv-verdict ${v.better}">${esc(v.text)}</span>` };
  }

  function renderCover() {
    if (rows.length === 0) {
      coverBox.innerHTML = `<h2>${esc(t('封面'))}</h2><p class="muted">${esc(t('曲目表建立后，这里显示各曲目的封面（默认用曲目自带的）。'))}</p>`;
      return;
    }
    const list = scope();
    const pics = pictures();
    const groups = new Map<string, { n: number; chosen: boolean; mode: string }>();
    for (const r of list) {
      const key = coverKey(r) ?? '';
      const g = groups.get(key) ?? { n: 0, chosen: false, mode: r.cover?.mode ?? 'replace' };
      g.n += 1;
      g.chosen ||= !!r.cover;
      groups.set(key, g);
    }
    const entries = [...groups].sort((a, b) => b[1].n - a[1].n);
    const cards = entries.map(([key, g], i) => {
      const p = key ? pics.get(key) : undefined;
      if (!key || !p) return `<div class="cv-none">${esc(t('没有封面（{n} 首）', { n: g.n }))}</div>`;
      const who = g.chosen ? `${esc(p.label)} · ${esc(t('手动指定'))}${g.mode === 'add' ? ` · ${esc(t('追加'))}` : ''}` : esc(t('曲目自带'));
      const count = entries.length === 1 ? t('{n} 首相同', { n: g.n }) : t('用于 {n} 首', { n: g.n });
      const spec = picSpec(p);
      return `<figure class="cv ${i === 0 ? 'first' : ''}">
        <a href="${esc(p.full)}" target="_blank" rel="noopener"><img src="${esc(p.src)}" alt="" /></a>
        <figcaption><b>${who}</b> · ${esc(count)}<br /><span class="muted">${esc(spec)}</span></figcaption>
      </figure>`;
    });
    const anyChosen = list.some((r) => r.cover);
    // While comparing: the online release's cover next to the tracks' own, with both sizes.
    const oc = compare?.online.cover;
    if (oc) {
      const text = onlineCoverText();
      cards.push(`<figure class="cv online">
        <a href="${esc(oc.url)}" target="_blank" rel="noopener" title="${esc(t('打开在线原图'))}"><img src="${esc(oc.thumb)}" alt="" /></a>
        <figcaption><b>${esc(t('在线 · {source} 原图', { source: oc.source }))}</b><br /><span class="muted">${text.spec}</span>${text.verdict ? `<br />${text.verdict}` : ''}</figcaption>
      </figure>`);
    }
    coverBox.innerHTML = `
      <h2>${esc(t('封面'))} ${selected.size ? `<small class="muted">${esc(t('所选 {n} 首', { n: selected.size }))}</small>` : ''}</h2>
      <div class="cv-list ${cards.length > 1 ? 'several' : ''}">${cards.join('')}</div>
      <p class="muted small">${esc(entries.length > 1 ? t('曲目的封面不同，这里并排显示，不强制统一。') : anyChosen ? t('下载时嵌入手动指定的封面。') : t('没有手动指定：默认用曲目自带的封面。'))}</p>
      <p><button type="button" data-act="cover">${esc(t('更换封面…'))}</button>
      ${anyChosen ? `<button type="button" data-act="cover-restore">${esc(t('恢复为曲目自带'))}</button>` : ''}</p>`;
  }

  coverBox.addEventListener('click', (e) => {
    const act = ((e.target as HTMLElement).closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'cover') coverDialog();
    if (act === 'cover-restore') {
      for (const r of scope()) r.cover = null;
      render();
    }
  });

  async function coverDialog() {
    const d = $<HTMLDialogElement>('#dlg-cover')!;
    const form = d.querySelector('form')!;
    const list = scope();
    let tab: 'file' | 'embedded' | 'upload' = 'file';
    let chosen: string | null = null;
    const first = list.find((r) => r.cover);
    if (first?.cover) chosen = coverKey(first);
    $('[data-title]', d)!.textContent = t('更换封面 · {edition}', { edition: data.edition.label });
    const keys = new Set(list.map(coverKey));
    $('[data-now]', d)!.textContent = t('现在：{what}。选中一张后，下面选择用于哪些曲目。', {
      what: keys.size > 1 ? t('各曲目不同（{n} 种）', { n: keys.size }) : list.some((r) => r.cover) ? t('手动指定') : t('曲目自带'),
    });
    $('[data-all]', d)!.textContent = t('本版全部 {n} 首', { n: rows.length });
    $('[data-sel]', d)!.textContent = selected.size ? t('所选 {n} 首', { n: selected.size }) : t('所选曲目（先在曲目列表里勾选）');
    const scopeAll = form.querySelector('input[name="scope"][value="all"]') as HTMLInputElement;
    const scopeSel = form.querySelector('input[name="scope"][value="selected"]') as HTMLInputElement;
    scopeSel.disabled = selected.size === 0;
    (selected.size ? scopeSel : scopeAll).checked = true;
    (form.querySelector(`input[name="mode"][value="${first?.cover?.mode ?? 'replace'}"]`) as HTMLInputElement).checked = true;
    $('[data-err]', d)!.textContent = '';
    const grid = $('[data-grid]', d)!;
    const draw = () => {
      for (const b of d.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
      $('[data-upload]', d)!.hidden = tab !== 'upload';
      grid.hidden = tab === 'upload';
      const shownPics = data.pictures.filter((p) => p.kind === tab);
      grid.innerHTML = shownPics.length
        ? shownPics.map((p) => `<button type="button" class="pick ${chosen === p.key ? 'on' : ''}" data-key="${esc(p.key)}" ${p.embeddable ? '' : `disabled title="${esc(t('只能嵌入 JPEG / PNG（或已生成缩小副本的大图）'))}"`}>
            <img src="${esc(p.src)}" alt="" loading="lazy" />
            <b>${esc(p.kind === 'embedded' ? t('曲目自带（{n} 个文件）', { n: p.tracks }) : p.label)}</b>
            <span class="muted">${esc([p.width && p.height ? `${p.width}×${p.height}` : '', p.mime.replace('image/', '').toUpperCase(), p.size ? size(p.size) : ''].filter(Boolean).join(' · '))}</span>
          </button>`).join('')
        : `<p class="muted">${esc(tab === 'file' ? t('这个版本里还没有图片。可以上传，或把扫图放进附件。') : t('曲目都没有自带封面。'))}</p>`;
      ($('[data-ok]', d) as HTMLButtonElement).disabled = !chosen;
    };
    const onClick = async (e: Event) => {
      const el = e.target as HTMLElement;
      const tabBtn = el.closest('[data-tab]') as HTMLElement | null;
      if (tabBtn) {
        tab = tabBtn.dataset.tab as typeof tab;
        draw();
        return;
      }
      const pick = el.closest('[data-key]') as HTMLButtonElement | null;
      if (pick && !pick.disabled) {
        chosen = pick.dataset.key!;
        draw();
      }
    };
    const onFile = async () => {
      const input = $<HTMLInputElement>('[data-file]', d)!;
      const file = input.files?.[0];
      if (!file) return;
      $('[data-err]', d)!.textContent = t('上传中…');
      const body = new FormData();
      body.append('file', file);
      try {
        const r = await fetch(`/admin/editions/${data.edition.id}/picture`, { method: 'POST', body, headers: { 'x-admin-request': '1' } });
        const j = (await r.json()) as { ok: boolean; id?: string; err?: string };
        if (!j.ok) throw new Error(j.err ?? t('上传失败'));
        const fresh = (await (await fetch(`/admin/editions/${data.edition.id}/data`)).json()) as { data: EditorData };
        data.pictures = fresh.data.pictures;
        chosen = `file:${j.id}`;
        tab = 'file';
        $('[data-err]', d)!.textContent = '';
        input.value = '';
        draw();
      } catch (err) {
        $('[data-err]', d)!.textContent = err instanceof Error ? err.message : String(err);
      }
    };
    d.addEventListener('click', onClick);
    $('[data-file]', d)!.addEventListener('change', onFile);
    draw();
    d.showModal();
    const result = await new Promise<string>((resolve) => d.addEventListener('close', () => resolve(d.returnValue), { once: true }));
    d.removeEventListener('click', onClick);
    $('[data-file]', d)!.removeEventListener('change', onFile);
    const targets = (form.querySelector('input[name="scope"]:checked') as HTMLInputElement).value === 'selected' ? rows.filter((r) => selected.has(r.id)) : rows;
    const mode = (form.querySelector('input[name="mode"]:checked') as HTMLInputElement).value as Cover['mode'];
    if (result === 'restore') for (const r of targets) r.cover = null;
    else if (result === 'ok' && chosen) {
      const [kind, id] = [chosen.slice(0, chosen.indexOf(':')), chosen.slice(chosen.indexOf(':') + 1)];
      for (const r of targets) {
        // A track's own picture as its cover is no choice at all.
        const own = kind === 'picture' && mainFile(r)?.cover === id && mode === 'replace';
        r.cover = own ? null : kind === 'file' ? { file: id, mode } : { picture: id, mode };
      }
    } else return;
    render();
  }

  // ------------------------------------------------------------------ 曲目列表
  function cellHtml(row: Row, name: string): string {
    const v = values(row, name);
    const st = status(row, name);
    const prop = proposal(row, name);
    const now = v.length ? esc(join(v)) : st === 'removed' ? `<s>${esc(join(original(row)[name]))}</s>` : '';
    if (prop) {
      return `<td class="cell prop-cell" data-cell="${esc(name)}"><span class="was">${now}</span><span class="will">${esc(join(prop))}</span>
        <span class="prop-acts"><button type="button" data-take="${esc(name)}" title="${esc(t('采用'))}">✓</button><button type="button" data-skip="${esc(name)}" title="${esc(t('不采用'))}">✕</button></span></td>`;
    }
    return `<td class="cell ${st}" data-cell="${esc(name)}" tabindex="0">${now}</td>`;
  }

  function panelHtml(row: Row, pos: { pos: number; total: number }, discs: number): string {
    const o = original(row);
    const names = sortNames([
      ...Object.keys(o).filter((k) => !NUMBERS.includes(k)), ...Object.keys(row.tags), ...data.display, ...shown, ...(rowShown.get(row.id) ?? []),
    ]);
    const pics = pictures();
    const file = mainFile(row);
    const ownCover = file?.cover ? pics.get(`picture:${file.cover}`) : undefined;
    const newCover = coverKey(row) ? pics.get(coverKey(row)!) : undefined;
    const picText = (p: EdPicture | undefined) => (p ? `${p.kind === 'embedded' ? t('曲目自带') : p.label}${p.width ? ` ${p.width}×${p.height}` : ''}` : '—');
    for (const name of onlineNames()) if (proposal(row, name) && !names.includes(name)) names.push(name);
    const trs = names.map((name) => {
      const st = status(row, name);
      const prop = proposal(row, name);
      const online = compare ? `<td class="online">${prop ? `<span class="will">${esc(join(prop))}</span> <button type="button" data-take="${esc(name)}" title="${esc(t('采用'))}">✓</button><button type="button" data-skip="${esc(name)}" title="${esc(t('不采用'))}">✕</button>` : ''}</td>` : '';
      return `<tr class="${st}">
        <th>${esc(label(name))} <small class="muted">${esc(name)}</small></th>
        <td class="orig">${o[name]?.length ? esc(join(o[name])) : '<span class="muted">—</span>'}</td>
        <td class="new"><input data-row="${esc(row.id)}" data-tag="${esc(name)}" value="${esc(join(values(row, name)))}" placeholder="${esc(st === 'removed' ? t('（删除）') : '')}" /></td>
        <td class="acts">
          ${name in row.tags ? `<button type="button" data-revert="${esc(name)}" title="${esc(t('恢复为文件原值'))}">↺</button>` : ''}
          ${values(row, name).length ? `<button type="button" data-drop="${esc(name)}" title="${esc(t('删除这个标签'))}">×</button>` : ''}
        </td>${online}</tr>`;
    });
    const origNumber = [o.tracknumber?.[0], o.totaltracks?.[0]].filter(Boolean).join('/');
    trs.push(`<tr><th>${esc(t('音轨号'))} <small class="muted">tracknumber</small></th><td class="orig">${esc(origNumber || '—')}</td>
      <td class="new ro">${pos.pos} / ${pos.total}${discs > 1 ? ` · ${esc(t('碟 {d}', { d: row.disc }))}` : ''}</td><td></td>${compare ? '<td></td>' : ''}</tr>`);
    trs.push(`<tr class="${row.cover ? 'changed' : ''}"><th>${esc(t('封面'))}</th><td class="orig">${esc(picText(ownCover))}</td><td class="new ro">${esc(picText(newCover))}${row.cover ? ` · ${esc(t('手动指定'))}` : ''}</td><td></td>${compare ? '<td></td>' : ''}</tr>`);
    const fileList = filesOf(row).map((id) => {
      const f = data.files[id];
      return `<li><a href="/admin/files/${esc(id)}">${esc(f.name)}</a> <span class="muted">${esc(f.spec)}${f.read ? '' : ` · ${esc(t('原有标签未读取'))}`}</span>
        <a href="/admin/download/${esc(id)}?tagged=1">${esc(t('带标签'))}</a> <a class="muted" href="/admin/download/${esc(id)}">${esc(t('原件'))}</a>
        <button type="button" class="linkish" data-unlink="${esc(id)}">${esc(t('移出这一行'))}</button></li>`;
    });
    return `<tr class="panel-row" data-panel="${esc(row.id)}"><td colspan="${columns.length + 7 + (compare ? 1 : 0)}">
      <div class="tri">
        <table class="tri-table"><thead><tr><th>${esc(t('标签'))}</th><th>${esc(t('文件原值'))}</th><th>${esc(t('新值（下载时写入）'))}</th><th></th>${compare ? `<th>${esc(t('在线'))}</th>` : ''}</tr></thead><tbody>${trs.join('')}</tbody></table>
        <p class="tri-actions">
          <button type="button" data-row-add="${esc(row.id)}">${esc(t('＋ 添加标签'))}</button>
          <button type="button" data-row-revert="${esc(row.id)}" ${Object.keys(row.tags).length ? '' : 'disabled'}>${esc(t('恢复为文件原值'))}</button>
          <label class="inline-check">${esc(t('碟号'))} <input type="number" min="1" max="99" value="${row.disc}" data-disc="${esc(row.id)}" style="width:4em" /></label>
          <button type="button" class="danger-link" data-row-remove="${esc(row.id)}">${esc(t('删除这一行'))}</button>
          <span class="muted small">${esc(t('绿 = 新增 · 黄 = 改动 · 红 = 删除（与 Picard 相同）'))}</span>
        </p>
        <ul class="tri-files">${fileList.join('') || `<li class="muted">${esc(t('这一行还没有对应的文件'))}</li>`}</ul>
      </div></td></tr>`;
  }

  function renderTracks() {
    const n = numbers();
    const pics = pictures();
    const total = rows.reduce((s, r) => s + ((r.duration ?? 0) / 1000 || mainFile(r)?.duration || 0), 0);
    const head = columns.map((c) => `<th>${esc(label(c))}</th>`).join('') + (compare ? `<th>${esc(t('对应在线'))}</th>` : '');
    const onlineOptions = (r: Row) => {
      const at = compare?.mapping.get(r.id);
      return `<select data-map="${esc(r.id)}" aria-label="${esc(t('对应在线'))}"><option value="">${esc(t('（不对应）'))}</option>${compare!.online.tracks.map((x, i) =>
        `<option value="${i}" ${at === i ? 'selected' : ''}>${x.disc > 1 ? `${x.disc}-` : ''}${String(x.position).padStart(2, '0')} ${esc(x.title)}${x.duration_ms ? ` (${clock(x.duration_ms / 1000)})` : ''}</option>`).join('')}</select>`;
    };
    const body = rows.map((r) => {
      const p = n.of.get(r.id)!;
      const key = coverKey(r);
      const pic = key ? pics.get(key) : undefined;
      const files = filesOf(r);
      const f = mainFile(r);
      return `<tr class="data-row ${selected.has(r.id) ? 'sel' : ''} ${expanded.has(r.id) ? 'open' : ''}" data-id="${esc(r.id)}" draggable="true">
          <td><input type="checkbox" data-select="${esc(r.id)}" ${selected.has(r.id) ? 'checked' : ''} aria-label="${esc(t('选中'))}" /></td>
          <td class="handle" title="${esc(t('拖动排序'))}">⠿</td>
          <td class="num">${n.discs > 1 ? `${r.disc}-` : ''}${String(p.pos).padStart(2, '0')}</td>
          <td class="thumb">${pic ? `<img src="${esc(pic.src)}" alt="" loading="lazy" />` : ''}</td>
          ${columns.map((c) => cellHtml(r, c)).join('')}
          ${compare ? `<td class="map">${onlineOptions(r)}</td>` : ''}
          <td class="muted">${clock((r.duration ?? 0) / 1000 || f?.duration)}</td>
          <td class="spec muted">${f ? esc(f.ext.toUpperCase() + ' ' + f.spec.replace(/^FLAC |^MP3 /, '')) : `<span class="missing">${esc(t('无文件'))}</span>`}${files.length > 1 ? ` <span class="chip">+${files.length - 1}</span>` : ''}</td>
          <td><button type="button" class="expand" data-expand="${esc(r.id)}" aria-label="${esc(t('展开'))}">${expanded.has(r.id) ? '▾' : '▸'}</button></td>
        </tr>${expanded.has(r.id) ? panelHtml(r, p, n.discs) : ''}`;
    }).join('');
    const loose = unlinked();
    const generate = rows.length === 0 && data.rows.length === 0
      ? `<div class="empty-tracks"><p class="muted">${esc(t('这个版本还没有曲目表。可以从版本里的音频文件生成（标题取自文件），也可以逐个「新建一行」，或用「查找元数据」从 MusicBrainz、Bandcamp 导入。'))}</p>
         <form method="post" class="inline"><input type="hidden" name="section" value="generate" /><input type="hidden" name="anchor" value="tracks" />
         <button class="primary" type="submit">${esc(t('从 {n} 个音频文件生成曲目表', { n: Object.keys(data.files).length }))}</button></form></div>`
      : '';
    const allTags = sortNames([...data.tagDefs.map((d) => d.name).filter((x) => !NUMBERS.includes(x)), ...columns]);
    tracks.innerHTML = `
      <div class="tracks-head">
        <h2>${esc(t('曲目列表'))} <small class="muted">${esc(t('{n} 首 · {time}', { n: rows.length, time: clock(total) }))}</small></h2>
        <span class="muted small">${esc(t('勾选曲目后，上方「版本信息」只显示和修改所选曲目'))}</span>
        <details class="col-pick"><summary class="button">${esc(t('列：{names}', { names: columns.map(label).join(' · ') }))}</summary>
          <div class="col-list">${allTags.map((c) => `<label><input type="checkbox" data-col="${esc(c)}" ${columns.includes(c) ? 'checked' : ''} /> ${esc(label(c))}</label>`).join('')}</div>
        </details>
      </div>
      ${generate}
      <div class="wide-table" ${rows.length ? '' : 'hidden'}><table class="grid ed-table">
        <thead><tr><th><input type="checkbox" data-select-all ${selected.size && selected.size === rows.length ? 'checked' : ''} aria-label="${esc(t('全选'))}" /></th><th></th><th class="num">#</th><th></th>${head}<th>${esc(t('时长'))}</th><th>${esc(t('文件'))}</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="tracks-foot">
        <button type="button" data-act="blank">${esc(t('＋ 新建一行'))}</button>
        <span class="muted small">${esc(t('拖动 ⠿ 调整顺序（就是改音轨号）；点格子直接改，点 ▸ 打开这一首的全部标签。'))}</span>
      </p>
      ${loose.length ? `<div class="loose">
        <b>${esc(t('还没对应到曲目的音频（{n} 个）', { n: loose.length }))}</b>
        <ul>${loose.map((id) => {
          const f = data.files[id];
          return `<li><a href="/admin/files/${esc(id)}">${esc(f.name)}</a> <span class="muted">${esc(f.spec)}${f.path ? ` · ${esc(f.path)}` : ''}</span>
            <button type="button" data-new-row="${esc(id)}">${esc(t('新建一行'))}</button>
            <select data-link="${esc(id)}" aria-label="${esc(t('对应到'))}"><option value="">${esc(t('对应到…'))}</option>${rows.map((r) => `<option value="${esc(r.id)}">${String(n.of.get(r.id)!.pos).padStart(2, '0')} ${esc(join(values(r, 'title')) || r.entry)}</option>`).join('')}</select></li>`;
        }).join('')}</ul>
        <form method="post" class="inline"><input type="hidden" name="section" value="match" /><input type="hidden" name="anchor" value="tracks" />
          <button type="submit">${esc(t('按曲号、标题和时长自动对应'))}</button></form>
      </div>` : ''}`;
  }

  // Selecting rows (Shift for a range), opening them, editing cells in place.
  let lastPicked: string | null = null;
  tracks.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const pick = el.closest('[data-select]') as HTMLInputElement | null;
    if (pick) {
      const id = pick.dataset.select!;
      if ((e as MouseEvent).shiftKey && lastPicked) {
        const a = rows.findIndex((r) => r.id === lastPicked);
        const b = rows.findIndex((r) => r.id === id);
        for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(r.id);
      } else if (pick.checked) selected.add(id);
      else selected.delete(id);
      lastPicked = id;
      render();
      return;
    }
    if (el.closest('[data-select-all]')) {
      if (selected.size === rows.length) selected.clear();
      else rows.forEach((r) => selected.add(r.id));
      render();
      return;
    }
    const exp = el.closest('[data-expand]') as HTMLElement | null;
    if (exp) {
      const id = exp.dataset.expand!;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
      return;
    }
    const take = el.closest('[data-take]') as HTMLElement | null;
    const skip = el.closest('[data-skip]') as HTMLElement | null;
    if (take || skip) {
      const id = (el.closest('[data-id]') as HTMLElement | null)?.dataset.id ?? (el.closest('[data-panel]') as HTMLElement | null)?.dataset.panel;
      const row = rows.find((r) => r.id === id);
      const name = (take ?? skip)!.dataset[take ? 'take' : 'skip']!;
      const v = row ? proposal(row, name) : null;
      if (row && v) {
        if (take) {
          setValues(row, name, v);
          remember();
        } else compare?.rejected.add(`${row.id}|${name}`);
      }
      render();
      return;
    }
    const cell = el.closest('td.cell') as HTMLElement | null;
    if (cell && !cell.classList.contains('prop-cell') && !cell.querySelector('input')) {
      editCell(cell);
      return;
    }
    const panelRow = el.closest('[data-panel]') as HTMLElement | null;
    const row = panelRow ? rows.find((r) => r.id === panelRow.dataset.panel) : undefined;
    const b = el.closest('button') as HTMLButtonElement | null;
    if (row && b?.dataset.revert) {
      delete row.tags[b.dataset.revert];
      render();
    } else if (row && b?.dataset.drop) {
      setValues(row, b.dataset.drop, []);
      render();
    } else if (b?.dataset.rowRevert) {
      const r = rows.find((x) => x.id === b.dataset.rowRevert);
      if (r) r.tags = {};
      render();
    } else if (b?.dataset.rowAdd) addTag(b.dataset.rowAdd);
    else if (b?.dataset.rowRemove) {
      if (!confirm(t('删除这一行？它的文件会回到「还没对应到曲目的音频」（保存前都可以放弃）。'))) return;
      rows = rows.filter((r) => r.id !== b.dataset.rowRemove);
      selected.delete(b.dataset.rowRemove);
      render();
    } else if (b?.dataset.unlink) {
      links.set(b.dataset.unlink, null);
      render();
    } else if (b?.dataset.newRow) {
      const f = data.files[b.dataset.newRow];
      const title = f.original.title?.[0] ?? f.name.replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '');
      rows.push({ id: `new:${f.id}`, disc: rows.at(-1)?.disc ?? 1, tags: newTags(title), cover: null, entry: title, duration: null });
      links.delete(f.id);
      render();
    } else if (b?.dataset.act === 'blank') {
      const title = prompt(t('新曲目的标题'))?.trim();
      if (!title) return;
      blank += 1;
      rows.push({ id: `blank:${blank}`, disc: rows.at(-1)?.disc ?? 1, tags: newTags(title), cover: null, entry: title, duration: null, title });
      render();
    }
  });
  tracks.addEventListener('change', (e) => {
    const el = e.target as HTMLElement;
    const input = el.closest('[data-tag]') as HTMLInputElement | null;
    if (input) {
      const row = rows.find((r) => r.id === input.dataset.row);
      if (row) setValues(row, input.dataset.tag!, parse(input.value));
      render({ keep: `${input.dataset.row}|${input.dataset.tag}` });
      return;
    }
    const disc = el.closest('[data-disc]') as HTMLInputElement | null;
    if (disc) {
      const row = rows.find((r) => r.id === disc.dataset.disc);
      const n = Math.max(1, Math.min(99, Number(disc.value) || 1));
      if (row) row.disc = n;
      render();
      return;
    }
    const col = el.closest('[data-col]') as HTMLInputElement | null;
    if (col) {
      columns = col.checked ? sortNames([...columns, col.dataset.col!]) : columns.filter((c) => c !== col.dataset.col);
      if (columns.length === 0) columns = ['title'];
      try {
        localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
      } catch {
        // kept for this page only
      }
      render();
      $<HTMLDetailsElement>('.col-pick', tracks)!.open = true;
      return;
    }
    const map = el.closest('[data-map]') as HTMLSelectElement | null;
    if (map && compare) {
      const i = map.value === '' ? null : Number(map.value);
      // An online track goes to one row: the row that had it lets go.
      for (const [k, v] of compare.mapping) if (i !== null && v === i) compare.mapping.set(k, null);
      compare.mapping.set(map.dataset.map!, i);
      render();
      return;
    }
    const link = el.closest('[data-link]') as HTMLSelectElement | null;
    if (link && link.value) {
      links.set(link.dataset.link!, link.value);
      render();
    }
  });
  tracks.addEventListener('keydown', (e) => {
    const input = (e.target as HTMLElement).closest('[data-tag]') as HTMLInputElement | null;
    if (input && e.key === 'Enter') {
      pendingFocus = `${input.dataset.row}|${input.dataset.tag}`;
      input.blur();
    }
    const cell = (e.target as HTMLElement).closest('td.cell') as HTMLElement | null;
    if (cell && e.key === 'Enter' && !cell.querySelector('input')) {
      e.preventDefault();
      editCell(cell);
    }
  });

  function editCell(cell: HTMLElement) {
    const id = cell.closest('tr')!.dataset.id!;
    const name = cell.dataset.cell!;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const input = document.createElement('input');
    input.value = join(values(row, name));
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean, move = 0) => {
      if (done) return;
      done = true;
      if (save) setValues(row, name, parse(input.value));
      render();
      if (move) {
        // Tab: the next cell (the next row's first one after the last column).
        const cells = [...tracks.querySelectorAll<HTMLElement>('td.cell')];
        const at = cells.findIndex((c) => c.closest('tr')!.dataset.id === id && c.dataset.cell === name);
        const next = cells[at + move];
        if (next) editCell(next);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, e.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Dragging rows into a new order: the table's rows move while dragging, the order is taken on drop.
  let dragged: HTMLElement | null = null;
  tracks.addEventListener('dragstart', (e) => {
    const tr = (e.target as HTMLElement).closest('tr.data-row') as HTMLElement | null;
    if (!tr || (e.target as HTMLElement).closest('input, button')) return;
    dragged = tr;
    tr.classList.add('dragging');
    (e as DragEvent).dataTransfer?.setData('text/plain', tr.dataset.id!);
  });
  tracks.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    const over = (e.target as HTMLElement).closest('tr.data-row') as HTMLElement | null;
    if (!over || over === dragged) return;
    const rect = over.getBoundingClientRect();
    const after = (e as DragEvent).clientY > rect.top + rect.height / 2;
    const panel = dragged.nextElementSibling?.classList.contains('panel-row') ? dragged.nextElementSibling : null;
    const anchor = after ? (over.nextElementSibling?.classList.contains('panel-row') ? over.nextElementSibling.nextElementSibling : over.nextElementSibling) : over;
    over.parentElement!.insertBefore(dragged, anchor);
    if (panel) (dragged as unknown as { after: (n: unknown) => void }).after(panel);
  });
  tracks.addEventListener('dragend', () => {
    if (!dragged) return;
    const id = dragged.dataset.id!;
    dragged = null;
    const ids = [...tracks.querySelectorAll<HTMLElement>('tr.data-row')].map((tr) => tr.dataset.id!);
    const byId = new Map(rows.map((r) => [r.id, r]));
    rows = ids.map((x) => byId.get(x)!).filter(Boolean);
    // A row dropped among another disc's rows joins that disc.
    const at = rows.findIndex((r) => r.id === id);
    const neighbour = rows[at - 1] ?? rows[at + 1];
    if (neighbour && (rows[at - 1]?.disc === rows[at + 1]?.disc || !rows[at + 1] || !rows[at - 1])) rows[at].disc = neighbour.disc;
    render();
  });

  /** A new row's tags: its title, and the album values every other row agrees on. */
  function newTags(title: string): Tags {
    const out: Tags = { title: [title] };
    if (rows.length === 0) return out;
    for (const name of albumNames(rows)) {
      const first = values(rows[0], name);
      if (first.length && rows.every((r) => same(values(r, name), first)) && defs.get(name)?.group !== 'people') out[name] = first;
    }
    return out;
  }

  // ------------------------------------------------------------------ adding tags, the display list
  async function addTag(rowId: string | null) {
    const d = $<HTMLDialogElement>('#dlg-addtag')!;
    const form = d.querySelector('form')!;
    const present = new Set(rowId ? Object.keys(rows.find((r) => r.id === rowId)?.tags ?? {}) : albumNames(scope()));
    const select = $<HTMLSelectElement>('[data-names]', d)!;
    select.innerHTML = data.tagDefs.filter((x) => !NUMBERS.includes(x.name) && x.name !== 'title' && !present.has(x.name))
      .map((x) => `<option value="${esc(x.name)}">${esc(x.label)} (${esc(x.name)})</option>`).join('');
    $('[data-scope]', d)!.textContent = rowId ? t('加到这一首') : selected.size ? t('加到所选 {n} 首', { n: selected.size }) : t('加到本版全部曲目');
    (form.elements.namedItem('custom') as HTMLInputElement).value = '';
    d.showModal();
    const r = await new Promise<string>((resolve) => d.addEventListener('close', () => resolve(d.returnValue), { once: true }));
    if (r !== 'ok') return;
    const custom = (form.elements.namedItem('custom') as HTMLInputElement).value.trim().toLowerCase().replace(/\s+/g, ' ');
    const name = custom || select.value;
    if (!name || /[=~]/.test(name)) return;
    if (rowId) rowShown.set(rowId, (rowShown.get(rowId) ?? new Set()).add(name));
    else shown.add(name);
    render({ keep: rowId ? `${rowId}|${name}` : `al-${name}` });
  }

  async function displayDialog() {
    const d = $<HTMLDialogElement>('#dlg-display')!;
    const common = new Set(['title', 'artist', 'album', 'albumartist', 'date', 'genre', 'composer', 'lyricist', 'arranger', 'label', 'catalognumber', 'comment']);
    const groups: Record<string, string> = { main: t('基本'), people: t('人员'), release: t('发行'), sort: t('排序用'), ids: t('编号与 ID'), other: t('其他') };
    const current = new Set(data.display);
    $('[data-list]', d)!.innerHTML = Object.entries(groups).map(([g, name]) => `<fieldset><legend>${esc(name)}</legend>${data.tagDefs
      .filter((x) => x.group === g && !NUMBERS.includes(x.name))
      .map((x) => `<label><input type="checkbox" value="${esc(x.name)}" ${current.has(x.name) || common.has(x.name) ? 'checked' : ''} ${common.has(x.name) ? 'disabled' : ''} /> ${esc(x.label)}</label>`).join('')}</fieldset>`).join('');
    d.showModal();
    const r = await new Promise<string>((resolve) => d.addEventListener('close', () => resolve(d.returnValue), { once: true }));
    if (r !== 'ok') return;
    const names = [...d.querySelectorAll<HTMLInputElement>('[data-list] input:checked:not(:disabled)')].map((i) => i.value);
    const res = await fetch('/admin/tag-display', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-request': '1' }, body: JSON.stringify({ names }) });
    if (res.ok) data.display = [...common, ...names];
    render();
  }

  // ------------------------------------------------------------------ the compare bar and the lookup panel
  const compareBar = document.createElement('div');
  compareBar.className = 'ed-compare';
  compareBar.hidden = true;
  (document.querySelector('.ed-top') as unknown as { before: (n: unknown) => void } | null)?.before(compareBar);

  function renderCompare() {
    if (!compare) {
      compareBar.hidden = true;
      return;
    }
    compareBar.hidden = false;
    const online = compare.online;
    const mapped = new Set([...compare.mapping.values()].filter((v): v is number => v != null));
    const extraOnline = online.tracks.map((x, i) => [x, i] as const).filter(([, i]) => !mapped.has(i));
    const extraLocal = rows.filter((r) => compare!.mapping.get(r.id) == null);
    const n = proposalCount();
    compareBar.innerHTML = `
      <div class="cmp-head">
        ${online.cover ? `<a href="${esc(online.cover.url)}" target="_blank" rel="noopener" title="${esc(t('打开在线原图'))}"><img class="cmp-thumb" src="${esc(online.cover.thumb)}" alt="" onerror="this.style.display='none'" /></a>` : ''}
        <div class="cmp-what">
          <b>${esc(t('正在对比：{label}', { label: online.label }))}</b> <a href="${esc(online.url)}" target="_blank" rel="noopener">↗</a><br />
          <span class="muted small">${esc(n ? t('{n} 处不同：旧值划掉、新值标绿，逐项 ✓ 采用或 ✕ 不采用。对比本身不改动任何东西，采用后和手动修改一样，保存后才生效。', { n }) : t('没有不同之处（或都已处理）。'))}</span>
        </div>
        <div class="cmp-actions">
          <button type="button" class="primary" data-cmp="all" ${n || compare.cover ? '' : 'disabled'}>${esc(t('全部应用'))}</button>
          <button type="button" data-cmp="other">${esc(t('换一个候选'))}</button>
          <button type="button" data-cmp="stop">${esc(t('取消对比'))}</button>
        </div>
      </div>
      ${online.cover ? (() => {
        const local = mainCover();
        const text = onlineCoverText();
        return `<div class="cmp-cover small">
          <span>${esc(t('在线封面（{source} 原图）', { source: online.cover.source }))}：${text.spec}</span>
          <span class="muted">${esc(t('本地当前'))}：${local ? esc(picSpec(local)) : esc(t('没有封面'))}</span>
          ${text.verdict}
        </div>
        <label class="inline-check small"><input type="checkbox" data-cmp-cover ${compare.cover ? 'checked' : ''} /> ${esc(t('同时采用在线封面（存进本版附件，替换全部曲目的正面封面）'))}</label>
        <button type="button" class="linkish small" data-cmp="cover">${esc(t('现在就采用封面'))}</button>`;
      })() : ''}
      ${extraOnline.length ? `<div class="cmp-extra"><b>${esc(t('在线版多出的曲目（{n}）', { n: extraOnline.length }))}</b> ${extraOnline.map(([x, i]) =>
        `<span class="chip">${x.disc > 1 ? `${x.disc}-` : ''}${x.position} ${esc(x.title)} <button type="button" class="linkish" data-cmp-add="${i}">${esc(t('新建一行'))}</button></span>`).join(' ')}</div>` : ''}
      ${extraLocal.length ? `<div class="cmp-extra"><b>${esc(t('本地多出的曲目（{n}，没有对应的在线曲目）', { n: extraLocal.length }))}</b> ${extraLocal.map((r) => `<span class="chip">${esc(join(values(r, 'title')) || r.entry)}</span>`).join(' ')}
        <span class="muted small">${esc(t('可以在曲目列表的「对应在线」一列里手动对应。'))}</span></div>` : ''}`;
  }

  let busy = '';
  async function takeCover(): Promise<boolean> {
    if (!compare?.online.cover) return false;
    busy = t('正在取回在线封面…');
    renderBar();
    const res = await fetch(`/admin/editions/${data.edition.id}/lookup`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-request': '1' },
      body: JSON.stringify({ op: 'cover', url: compare.online.cover.url, fallback: compare.online.cover.large }),
    });
    const j = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; id?: string; err?: string };
    busy = '';
    if (!j.ok || !j.id) {
      alert(j.err ?? t('封面下载失败'));
      renderBar();
      return false;
    }
    const fresh = (await (await fetch(`/admin/editions/${data.edition.id}/data`)).json()) as { data: EditorData };
    data.pictures = fresh.data.pictures;
    // The tracks being compared; all of them when none has an online counterpart.
    const compared = rows.filter((r) => compare!.mapping.get(r.id) != null);
    for (const r of compared.length ? compared : rows) r.cover = { file: j.id, mode: 'replace' };
    compare.cover = false;
    remember();
    return true;
  }

  compareBar.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const act = (el.closest('[data-cmp]') as HTMLElement | null)?.dataset.cmp;
    const add = el.closest('[data-cmp-add]') as HTMLElement | null;
    if (add && compare) {
      const x = compare.online.tracks[Number(add.dataset.cmpAdd)];
      blank += 1;
      const id = `blank:${blank}`;
      rows.push({ id, disc: x.disc, tags: { ...compare.online.album, ...x.tags }, cover: null, entry: x.title, duration: x.duration_ms, title: x.title });
      compare.mapping.set(id, Number(add.dataset.cmpAdd));
      render();
      return;
    }
    if (act === 'stop') {
      compare = null;
      render();
    } else if (act === 'other') openLookup();
    else if (act === 'cover') {
      if (await takeCover()) render();
    } else if (act === 'all') {
      (el as HTMLButtonElement).disabled = true;
      takeAll();
      if (compare?.cover) await takeCover();
      render();
    }
  });
  compareBar.addEventListener('change', (e) => {
    const box = (e.target as HTMLElement).closest('[data-cmp-cover]') as HTMLInputElement | null;
    if (box && compare) {
      compare.cover = box.checked;
      renderCompare(); // 「全部应用」 has something to do now (or not)
    }
  });

  const panel = $('#lookup');
  document.querySelector('[data-act="lookup"]')?.addEventListener('click', () => openLookup());
  async function openLookup(query?: string) {
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `
      <div class="lk-head"><b>${esc(t('查找元数据'))}</b><button type="button" class="tf-btn" data-lk="close" aria-label="${esc(t('关闭'))}">×</button></div>
      <form class="lk-search" data-lk-form="search">
        <input name="q" value="${esc(query ?? data.edition.search)}" aria-label="${esc(t('搜索'))}" />
        <button type="submit">${esc(t('搜索'))}</button>
      </form>
      <form class="lk-search" data-lk-form="ref">
        <input name="ref" placeholder="${esc(t('或粘贴 MusicBrainz / Bandcamp 链接'))}" />
        <button type="submit">${esc(t('打开'))}</button>
      </form>
      <p class="muted small">${esc(t('按编号、曲数、每首时长和标题排序；点「对比」把差异标在版本信息和曲目列表里。'))}</p>
      <div class="lk-list"><p class="muted">${esc(t('正在查找…'))}</p></div>`;
    const list = $('.lk-list', panel)!;
    const q = query === undefined ? '' : query;
    try {
      const res = await fetch(`/admin/editions/${data.edition.id}/lookup?op=candidates${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      const j = (await res.json()) as { ok: boolean; err?: string; candidates?: {
        source: string; id: string; title: string; artist: string | null; date: string | null; format: string | null; tracks: number;
        catalogs: string[]; country: string | null; disambiguation: string | null; thumb: string | null; score: number; url: string;
      }[] };
      if (!j.ok) throw new Error(j.err ?? t('查找失败'));
      list.innerHTML = (j.candidates ?? []).map((c) => `<div class="lk-card">
          ${c.thumb ? `<img src="${esc(c.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />` : '<span class="lk-noimg"></span>'}
          <div class="lk-info">
            <b>${esc(c.title)}</b>${c.disambiguation ? ` <span class="muted">(${esc(c.disambiguation)})</span>` : ''}<br />
            <span class="muted small">${esc([c.artist, c.date, c.format, t('{n} 曲', { n: c.tracks }), c.catalogs.join(', '), c.country, c.source === 'bandcamp' ? 'Bandcamp' : 'MusicBrainz'].filter(Boolean).join(' · '))}</span>
            <div class="lk-score" title="${esc(t('匹配度 {p}%', { p: Math.round(c.score * 100) }))}"><span style="width:${Math.round(c.score * 100)}%"></span></div>
          </div>
          <div class="lk-acts"><button type="button" class="primary" data-lk-compare="${esc(c.source === 'bandcamp' ? c.url : c.id)}">${esc(t('对比'))}</button>
            <a href="${esc(c.url)}" target="_blank" rel="noopener">↗</a></div>
        </div>`).join('') || `<p class="muted">${esc(t('没有找到候选。可以换个关键词，或直接贴链接。'))}</p>`;
    } catch (err) {
      list.innerHTML = `<p class="err-line">${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  }
  /** Read the online cover's size (the original's first bytes, on the server) and show it. */
  async function loadCoverInfo(c: NonNullable<typeof compare>) {
    const cover = c.online.cover!;
    const res = await fetch(`/admin/editions/${data.edition.id}/lookup?op=cover-info&url=${encodeURIComponent(cover.url)}`).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { ok: boolean; info?: CoverInfo; err?: string } | null;
    c.coverInfo = j?.ok && j.info ? j.info : { err: j?.err ?? t('读不出在线封面的尺寸') };
    if (compare === c) render();
  }
  async function startCompare(ref: string) {
    if (!panel) return;
    const list = $('.lk-list', panel);
    if (list) list.innerHTML = `<p class="muted">${esc(t('正在读取…'))}</p>`;
    try {
      const res = await fetch(`/admin/editions/${data.edition.id}/lookup?op=release&ref=${encodeURIComponent(ref)}`);
      const j = (await res.json()) as { ok: boolean; err?: string; release?: Online };
      if (!j.ok || !j.release) throw new Error(j.err ?? t('读取失败'));
      compare = { online: j.release, mapping: autoMap(j.release), rejected: new Set(), cover: false };
      panel.hidden = true;
      render();
      compareBar.scrollIntoView({ block: 'nearest' });
      if (j.release.cover) loadCoverInfo(compare);
    } catch (err) {
      if (list) list.innerHTML = `<p class="err-line">${esc(err instanceof Error ? err.message : String(err))}</p>`;
    }
  }
  panel?.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-lk="close"]')) panel.hidden = true;
    const cmp = el.closest('[data-lk-compare]') as HTMLElement | null;
    if (cmp) startCompare(cmp.dataset.lkCompare!);
  });
  panel?.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    if (form.dataset.lkForm === 'ref') startCompare(input.value);
    else openLookup(input.value);
  });

  // ------------------------------------------------------------------ saving
  const bar = $('.ed-savebar')!;
  function renderBar() {
    const n = changes();
    bar.hidden = n === 0 && !busy;
    $('[data-dirty]', bar)!.textContent = busy || t('{n} 处改动未保存 · 保存后可在修改记录里撤销', { n });
    $<HTMLButtonElement>('[data-act="save"]', bar)!.disabled = !!busy;
    const note = $('[data-archive-note]');
    if (note) note.hidden = n === 0;
  }
  bar.addEventListener('click', async (e) => {
    const act = ((e.target as HTMLElement).closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'discard' && confirm(t('放弃全部未保存的改动？'))) {
      window.onbeforeunload = null;
      location.reload();
    }
    if (act === 'save') await save();
  });
  async function save() {
    if (busy) return;
    const button = $<HTMLButtonElement>('[data-act="save"]', bar)!;
    button.disabled = true;
    try {
      const body = {
        version: data.version, rows: rows.map((r) => ({ id: r.id, disc: r.disc, tags: r.tags, cover: r.cover, title: r.title })),
        links: [...links].map(([file, row]) => ({ file, row })), edition_ids: editionIds,
      };
      const res = await fetch(`/admin/editions/${data.edition.id}/tags`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-request': '1' }, body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({ ok: false, err: t('保存失败') }))) as { ok: boolean; msg?: string; err?: string; batch?: string | null };
      if (!j.ok) throw new Error(j.err ?? t('保存失败'));
      window.onbeforeunload = null;
      const next = new URL(location.href);
      next.searchParams.set('msg', j.msg ?? '');
      if (j.batch) next.searchParams.set('undo', j.batch);
      else next.searchParams.delete('undo');
      next.searchParams.delete('err');
      next.hash = 'tracks';
      location.href = next.toString();
    } catch (err) {
      $('[data-dirty]', bar)!.textContent = err instanceof Error ? err.message : String(err);
      button.disabled = false;
    }
  }
  window.onbeforeunload = (e) => {
    if (changes()) {
      e.preventDefault();
      return '';
    }
    return undefined;
  };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && changes()) {
      e.preventDefault();
      save();
    }
  });
  $('#archive')?.addEventListener('submit', (e) => {
    if (changes() && !confirm(t('标签的改动还没保存：只保存归档信息的话，标签的改动会丢失。继续吗？'))) e.preventDefault();
    else window.onbeforeunload = null;
  });

  // ------------------------------------------------------------------ drawing
  // Drawing replaces the panels (and the focused input, whose blur may fire another change): one at a time.
  let drawing = false;
  let pendingFocus: string | null = null;
  function render(opts: { keep?: string } = {}) {
    if (drawing) return;
    drawing = true;
    try {
      renderNow(opts);
    } finally {
      drawing = false;
    }
  }
  function renderNow(opts: { keep?: string }) {
    const active = document.activeElement as HTMLElement | null;
    const keep = opts.keep ?? pendingFocus ?? (active?.id?.startsWith('al-') ? active.id : active?.dataset?.tag ? `${active.dataset.row}|${active.dataset.tag}` : null);
    pendingFocus = null;
    if (active && (info.contains(active) || tracks.contains(active)) && active.tagName === 'INPUT') active.blur();
    renderInfo();
    renderCover();
    renderTracks();
    renderCompare();
    renderBar();
    if (keep) {
      const el = keep.startsWith('al-')
        ? document.getElementById(keep)
        : tracks.querySelector(`[data-row="${CSS.escape(keep.split('|')[0])}"][data-tag="${CSS.escape(keep.split('|')[1])}"]`);
      (el as HTMLInputElement | null)?.focus();
    }
  }

  /** Open one track's three columns and bring it into view. */
  function openRow(id: string) {
    if (!rows.some((r) => r.id === id)) return;
    expanded.add(id);
    render();
    tracks.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
  }

  /**
   * The files changed on the page (moved, renamed, deleted, a cover set): take the edition's data again.
   * Only when nothing is unsaved (false otherwise: the list then shows the files as they were until saved).
   */
  async function reload(): Promise<boolean> {
    if (changes() || busy) return false;
    const res = await fetch(`/admin/editions/${data.edition.id}/data`).catch(() => null);
    const fresh = (await res?.json().catch(() => null)) as { ok?: boolean; data?: EditorData } | null;
    if (!fresh?.data || changes()) return false;
    Object.assign(data, fresh.data);
    rows = data.rows.map((r) => ({ id: r.id, disc: r.disc, tags: structuredClone(r.tags), cover: r.cover, entry: r.entry_title, duration: r.duration_ms }));
    baseFiles.clear();
    for (const r of data.rows) baseFiles.set(r.id, r.files);
    links.clear();
    for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);
    initial = snapshot();
    render();
    return true;
  }

  // #row=<id>: open one track (the 整理台's 「编辑标签」 comes here).
  const want = new URLSearchParams(location.hash.slice(1)).get('row');
  if (want && rows.some((r) => r.id === want)) expanded.add(want);
  render();
  if (want) tracks.querySelector(`[data-id="${CSS.escape(want)}"]`)?.scrollIntoView({ block: 'center' });
  return { rows: () => rows, render, values, setValues, original, scope, coverKey, changes, openRow, reload };
}

export type Editor = ReturnType<typeof initEditor>;

const node = document.querySelector('#ed-data');
if (node) {
  const editor = initEditor(JSON.parse(node.textContent ?? '{}') as EditorData);
  (window as unknown as { rigelEditor?: Editor }).rigelEditor = editor;
}
