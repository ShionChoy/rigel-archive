// The player (components/Player.astro): a queue of tracks offered by the page, played one after another,
// kept in this browser (localStorage rigel.player) so a reload or a later visit picks up where it stopped.
//
// Addresses on the public site run out after a while (lib/public/media.ts); a track whose address has run
// out, or that fails to load, gets a new one from /api/play and goes on from the same second.
// A track comes in versions (lib/playback.ts): 无损 (the stream FLAC), 原件 (the file as collected) and 省流
// (AAC), as far as the track's access allows; a track limited to a preview clip comes as the clip only.
// 无损 plays unless the browser cannot or the visitor picked another version in the menu (kept in this
// browser for every track).

type Kind = 'lossless' | 'original' | 'lossy';
interface Source { src: string; type: string; label?: string; lossless?: boolean; kind?: Kind; size?: number | null; same?: boolean; locked?: boolean; span?: [number, number] }
interface Item {
  file: string | null;
  title: string;
  sub: string;
  album: string;
  cover: string | null;
  href: string | null;
  sources: Source[] | null;
  exp: number | null;
}
type Repeat = 'off' | 'all' | 'one';
interface Saved { queue: Item[]; index: number; time: number; shuffle: boolean; repeat: Repeat; pref: Kind; volume: number }

/** A version's kind (sources kept from before versions had one: lossless or not). */
const kindOf = (s: Source): Kind => s.kind ?? (s.lossless === false ? 'lossy' : 'lossless');
/** Which versions to try first for each preference. */
const ORDER: Record<Kind, Kind[]> = { lossless: ['lossless', 'original', 'lossy'], original: ['original', 'lossless', 'lossy'], lossy: ['lossy', 'lossless', 'original'] };

const KEY = 'rigel.player';
const root = document.getElementById('player');
if (root && !root.dataset.ready) {
  root.dataset.ready = '1';
  setUp(root);
}

function setUp(root: HTMLElement) {
  const L = JSON.parse(root.dataset.labels ?? '{}') as Record<string, string>;
  const $ = <E extends Element>(sel: string) => root.querySelector<E>(sel)!;
  const audio = $<HTMLAudioElement>('audio');
  const seek = $<HTMLInputElement>('.pl-seek');
  const volume = $<HTMLInputElement>('.pl-volume');
  const queueBox = $<HTMLElement>('.pl-queue');
  const qmenu = $<HTMLElement>('.pl-qmenu');

  const state: Saved = restore();
  let order: number[] = [];
  /** The queue position loaded into the audio element (-1: none yet; a restored queue loads on play). */
  let loaded = -1;
  let source: Source | null = null;
  let pendingTime = 0;
  let retried = false;
  let seeking = false;
  let lastSave = 0;
  /** Tracks that failed in a row: when the whole queue has, stop instead of going round it for ever. */
  let failures = 0;


  // ------------------------------------------------------------ keeping it
  function restore(): Saved {
    const fallback: Saved = { queue: [], index: 0, time: 0, shuffle: false, repeat: 'off', pref: 'lossless', volume: 1 };
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as (Partial<Saved> & { saver?: boolean }) | null;
      if (!raw || !Array.isArray(raw.queue)) return fallback;
      return {
        queue: raw.queue.filter((i) => i && typeof i.title === 'string').slice(0, 500),
        index: Number(raw.index) || 0,
        time: Number(raw.time) || 0,
        shuffle: !!raw.shuffle,
        repeat: raw.repeat === 'all' || raw.repeat === 'one' ? raw.repeat : 'off',
        // Before the menu there was only 省流 on or off.
        pref: raw.pref === 'original' || raw.pref === 'lossy' || raw.pref === 'lossless' ? raw.pref : raw.saver ? 'lossy' : 'lossless',
        volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : 1,
      };
    } catch {
      return fallback;
    }
  }

  function save(now = false) {
    if (!now && Date.now() - lastSave < 4000) return;
    lastSave = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...state, time: loaded === state.index ? audio.currentTime : state.time }));
    } catch {
      // private mode or full: the player still works, it is just not kept
    }
  }

  // ------------------------------------------------------------ order
  /** The play order: the queue as it is, or shuffled with the current track first. */
  function reorder(shuffle: boolean) {
    const all = state.queue.map((_, i) => i);
    if (!shuffle) {
      order = all;
      return;
    }
    const rest = all.filter((i) => i !== state.index);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    order = state.queue.length ? [state.index, ...rest] : [];
  }

  const current = () => state.queue[state.index] as Item | undefined;

  // ------------------------------------------------------------ playing
  /** The version to play: the preferred kind first, among those open here that this browser plays. */
  function pick(item: Item, prefer: Kind = state.pref): Source | null {
    const open = (item.sources ?? []).filter((s) => s.src && !s.locked);
    const list = open.filter((s) => audio.canPlayType(s.type) !== '');
    if (list.length === 0) return open.at(-1) ?? null;
    for (const kind of ORDER[prefer]) {
      const found = list.find((s) => kindOf(s) === kind);
      if (found) return found;
    }
    return list[0];
  }

  async function refresh(item: Item): Promise<boolean> {
    if (!item.file) return false;
    try {
      const res = await fetch(`/api/play?f=${encodeURIComponent(item.file)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return false;
      const data = (await res.json()) as { sources: Source[]; exp: number | null };
      item.sources = data.sources;
      item.exp = data.exp;
      save(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Load queue position `index` and, with `play`, start it (at `time` seconds). */
  async function load(index: number, opts: { play: boolean; time?: number }): Promise<void> {
    const item = state.queue[index];
    if (!item) return;
    state.index = index;
    if (item.exp && item.exp * 1000 < Date.now() + 60_000) await refresh(item);
    const chosen = pick(item);
    if (!chosen) return failed();
    loaded = index;
    source = chosen;
    retried = false;
    pendingTime = opts.time ?? 0;
    audio.src = chosen.src;
    if (opts.play) audio.play().catch(() => render());
    else audio.load();
    render();
    save(true);
  }

  /** The current track cannot be played: say so and go on to the next, unless nothing in the queue plays. */
  function failed(): Promise<void> | void {
    toast(L.failed);
    failures += 1;
    if (failures >= state.queue.length) {
      failures = 0;
      audio.pause();
      return render();
    }
    return advance(true);
  }

  /** The next track in the play order; `auto` when the last one ended (repeat and the end of the queue apply). */
  function advance(auto: boolean): Promise<void> | void {
    if (!state.queue.length) return;
    if (auto && state.repeat === 'one') return load(state.index, { play: true });
    const at = order.indexOf(state.index);
    let next = at + 1;
    if (next >= order.length) {
      if (auto && state.repeat === 'off') {
        audio.pause();
        audio.currentTime = 0;
        return render();
      }
      next = 0;
    }
    return load(order[next], { play: true });
  }

  function back() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const at = order.indexOf(state.index);
    load(order[Math.max(0, at - 1)], { play: true });
  }

  function toggle() {
    if (!current()) return;
    if (loaded !== state.index) return load(state.index, { play: true, time: state.time });
    if (audio.paused) audio.play().catch(() => render());
    else audio.pause();
  }

  /** Play these tracks from `start` (the page's list becomes the queue). */
  function playList(items: Item[], start: number) {
    const playable = items.filter((i) => i.sources && i.sources.length);
    if (!playable.length) return toast(L.nothing);
    const first = Math.max(0, playable.indexOf(items[start]));
    state.queue = playable;
    state.index = first;
    reorder(state.shuffle);
    load(first, { play: true });
  }

  // ------------------------------------------------------------ showing it
  const clock = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  function render() {
    const item = current();
    root.hidden = !item;
    if (!item) {
      highlight();
      return;
    }
    const playing = !audio.paused && loaded === state.index;
    root.classList.toggle('playing', playing);
    // The title links to where the track was played from.
    const title = $<HTMLElement>('.pl-title');
    if (item.href) {
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.title;
      title.replaceChildren(a);
    } else {
      title.textContent = item.title;
    }
    $('.pl-sub').textContent = [item.sub, item.album].filter(Boolean).join(' · ');
    const cover = $<HTMLImageElement>('.pl-cover');
    if (item.cover) cover.src = item.cover;
    else cover.removeAttribute('src');
    const toggleButton = $<HTMLButtonElement>('.pl-toggle');
    toggleButton.setAttribute('aria-label', playing ? L.pause : L.play);
    toggleButton.title = playing ? L.pause : L.play;
    const shuffle = $<HTMLButtonElement>('.pl-shuffle');
    shuffle.setAttribute('aria-pressed', String(state.shuffle));
    shuffle.title = state.shuffle ? L.shuffleOn : L.shuffleOff;
    shuffle.setAttribute('aria-label', shuffle.title);
    const repeat = $<HTMLButtonElement>('.pl-repeat');
    repeat.dataset.mode = state.repeat;
    repeat.title = state.repeat === 'one' ? L.repeatOne : state.repeat === 'all' ? L.repeatAll : L.repeatOff;
    repeat.setAttribute('aria-label', repeat.title);
    const quality = $<HTMLButtonElement>('.pl-quality');
    const shown = loaded === state.index && source ? source : pick(item);
    const kind = shown ? kindOf(shown) : state.pref;
    quality.classList.toggle('saver', kind === 'lossy');
    // A clip's range as the album page writes it (whole seconds, rounded).
    $('.pl-format').textContent = shown?.span ? `${clock(Math.round(shown.span[0]))}–${clock(Math.round(shown.span[1]))}` : shown?.label ?? '';
    $('.pl-mode').textContent = shown?.span ? L.clip : kind === 'original' ? L.original : kind === 'lossy' ? L.saver : L.lossless;
    if (!qmenu.hidden) drawVersions();
    if (loaded !== state.index) {
      $('.pl-cur').textContent = clock(state.time);
      $('.pl-dur').textContent = '';
      seek.value = '0';
    }
    if (!queueBox.hidden) drawQueue();
    highlight();
    session(item, playing);
  }

  function drawQueue() {
    const list = queueBox.querySelector('ol')!;
    list.replaceChildren(...state.queue.map((item, i) => {
      const li = document.createElement('li');
      li.classList.toggle('on', i === state.index);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(i);
      const n = document.createElement('span');
      n.className = 'q-n';
      n.textContent = String(i + 1);
      const text = document.createElement('span');
      text.textContent = item.title;
      const sub = document.createElement('span');
      sub.className = 'q-sub';
      sub.textContent = [item.sub, item.album].filter(Boolean).join(' · ');
      text.appendChild(sub);
      button.appendChild(n); // (append with two nodes clashes with the Workers types' Element.append)
      button.appendChild(text);
      li.appendChild(button);
      return li;
    }));
    list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }

  /** Mark the playing track wherever the page lists it. */
  function highlight() {
    const file = current()?.file ?? null;
    const on = !root.hidden && loaded === state.index;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-file]'))) {
      const now = on && !!file && row.dataset.file === file;
      row.classList.toggle('now', now);
      row.classList.toggle('playing', now && !audio.paused);
    }
  }

  function session(item: Item, playing: boolean) {
    if (!('mediaSession' in navigator)) return;
    const cover = item.cover ? new URL(item.cover, location.href).href : null;
    const meta = navigator.mediaSession.metadata;
    if (!meta || meta.title !== item.title || meta.album !== item.album) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: item.sub, album: item.album, artwork: cover ? [{ src: cover }] : [] });
    }
    navigator.mediaSession.playbackState = playing ? 'playing' : loaded === state.index ? 'paused' : 'none';
  }

  let toastTimer = 0;
  function toast(text: string) {
    const box = $<HTMLElement>('.pl-toast');
    box.textContent = text;
    box.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => box.classList.remove('on'), 3500);
  }

  // ------------------------------------------------------------ the audio element
  audio.addEventListener('loadedmetadata', () => {
    if (pendingTime > 0 && pendingTime < audio.duration - 1) audio.currentTime = pendingTime;
    pendingTime = 0;
    $('.pl-dur').textContent = clock(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    if (loaded !== state.index) return;
    $('.pl-cur').textContent = clock(audio.currentTime);
    if (!seeking && audio.duration) seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    state.time = audio.currentTime;
    save();
    if ('mediaSession' in navigator && audio.duration && Number.isFinite(audio.duration)) {
      try {
        navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate });
      } catch {
        // some browsers reject position states while loading
      }
    }
  });
  audio.addEventListener('play', render);
  audio.addEventListener('pause', () => {
    render();
    save(true);
  });
  audio.addEventListener('ended', () => advance(true));
  audio.addEventListener('error', async () => {
    const item = current();
    if (!item || loaded !== state.index || !audio.getAttribute('src')) return;
    // An address that ran out (or a network hiccup): once with a new address, from the same second.
    if (!retried && item.file) {
      retried = true;
      const at = audio.currentTime || state.time;
      if (await refresh(item)) {
        const chosen = pick(item);
        if (chosen) {
          source = chosen;
          pendingTime = at;
          audio.src = chosen.src;
          audio.play().catch(() => render());
          return;
        }
      }
    }
    failed();
  });
  audio.addEventListener('playing', () => {
    failures = 0;
  });

  // ------------------------------------------------------------ the player's own controls
  $('.pl-toggle').addEventListener('click', toggle);
  $('.pl-next').addEventListener('click', () => advance(false));
  $('.pl-prev').addEventListener('click', back);
  $('.pl-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    reorder(state.shuffle);
    render();
    save(true);
  });
  $('.pl-repeat').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    render();
    save(true);
  });
  // The versions menu: what this track offers, the one playing marked; picking one switches over at the
  // same second and becomes the preference for the tracks after it.
  function drawVersions() {
    const item = current();
    const list = item?.sources ?? [];
    const playing = loaded === state.index && source ? source : item ? pick(item) : null;
    const head = document.createElement('div');
    head.className = 'qm-head';
    head.textContent = L.versions;
    const rows = list.map((s) => {
      const kind = kindOf(s);
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      const on = !!playing && s.src === playing.src && !s.locked;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.disabled = !!s.locked || !s.src;
      b.dataset.kind = kind;
      const dot = document.createElement('span');
      dot.className = 'qm-dot';
      const text = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'qm-name';
      name.textContent = s.span ? `${L.clip} · ${kind === 'lossy' ? L.saver : L.lossless}` : kind === 'original' ? L.original : kind === 'lossy' ? L.saver : L.lossless;
      const spec = document.createElement('span');
      spec.className = 'qm-spec';
      spec.textContent = [s.label, s.size ? `${(s.size / 1048576).toFixed(1)} MB` : ''].filter(Boolean).join(' · ');
      text.appendChild(name);
      text.appendChild(spec);
      if (!s.locked && !s.span && kind === 'lossless') {
        const tag = document.createElement('span');
        tag.className = 'qm-tag';
        tag.textContent = L.defaultMark;
        text.appendChild(tag);
      }
      const hint = document.createElement('span');
      hint.className = 'qm-hint';
      hint.textContent = s.locked ? L.locked : s.span ? L.clipHint : kind === 'original' ? L.originalHint : kind === 'lossy' ? L.saverHint : s.same ? L.losslessHint : L.losslessOtherHint;
      text.appendChild(hint);
      b.appendChild(dot);
      b.appendChild(text);
      return b;
    });
    const foot = document.createElement('div');
    foot.className = 'qm-foot';
    foot.textContent = L.remember;
    qmenu.replaceChildren(head, ...rows, foot);
  }
  function closeVersions() {
    qmenu.hidden = true;
    $('.pl-quality').setAttribute('aria-expanded', 'false');
  }
  $('.pl-quality').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!qmenu.hidden) return closeVersions();
    drawVersions();
    qmenu.hidden = false;
    $('.pl-quality').setAttribute('aria-expanded', 'true');
  });
  qmenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');
    if (!b || b.disabled) return;
    state.pref = b.dataset.kind as Kind;
    const item = current();
    // Switch the playing track over at the same second.
    if (item && loaded === state.index) {
      const next = pick(item);
      if (next && next.src !== source?.src) {
        const wasPlaying = !audio.paused;
        source = next;
        pendingTime = audio.currentTime;
        audio.src = next.src;
        if (wasPlaying) audio.play().catch(() => render());
      }
    }
    closeVersions();
    render();
    save(true);
  });
  document.addEventListener('click', (e) => {
    if (!qmenu.hidden && !(e.target as HTMLElement).closest('.pl-qmenu')) closeVersions();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !qmenu.hidden) closeVersions();
  });
  seek.addEventListener('input', () => {
    seeking = true;
    if (audio.duration) $('.pl-cur').textContent = clock((Number(seek.value) / 1000) * audio.duration);
  });
  seek.addEventListener('change', () => {
    seeking = false;
    if (loaded !== state.index) return load(state.index, { play: true, time: 0 });
    if (audio.duration) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  });
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
    state.volume = audio.volume;
    save();
  });
  $('.pl-queue-btn').addEventListener('click', () => {
    queueBox.hidden = !queueBox.hidden;
    $('.pl-queue-btn').setAttribute('aria-expanded', String(!queueBox.hidden));
    if (!queueBox.hidden) drawQueue();
  });
  queueBox.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-index]');
    if (b) load(Number(b.dataset.index), { play: true });
  });
  const clear = () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.queue = [];
    state.index = 0;
    state.time = 0;
    loaded = -1;
    source = null;
    queueBox.hidden = true;
    render();
    save(true);
  };
  $('.pl-clear').addEventListener('click', clear);
  $('.pl-close').addEventListener('click', clear);

  if ('mediaSession' in navigator) {
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => toggle()],
      ['pause', () => audio.pause()],
      ['previoustrack', () => back()],
      ['nexttrack', () => advance(false)],
      ['seekto', (d) => { if (d.seekTime !== undefined) audio.currentTime = d.seekTime; }],
      ['seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset ?? 10)); }],
      ['seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset ?? 10)); }],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // not supported here
      }
    }
  }

  // ------------------------------------------------------------ the page's tracks
  const itemOf = (el: Element): Item | null => {
    try {
      return JSON.parse((el as HTMLElement).dataset.track ?? 'null') as Item | null;
    } catch {
      return null;
    }
  };
  const itemsIn = (list: Element | null) => (list ? Array.from(list.querySelectorAll('[data-track]')) : []);

  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const play = target.closest<HTMLElement>('[data-play]');
    if (play) {
      const row = play.closest('[data-track]');
      const item = row && itemOf(row);
      if (!row || !item) return;
      // The playing track's own button pauses and resumes it.
      if (item.file && item.file === current()?.file && loaded === state.index) return toggle();
      const rows = itemsIn(row.closest('[data-queue]') ?? row.parentElement);
      const items = rows.map(itemOf);
      playList(items.filter((i): i is Item => !!i), Math.max(0, rows.indexOf(row)));
      return;
    }
    const all = target.closest<HTMLElement>('[data-play-all]');
    if (all) {
      const items = itemsIn(document.querySelector(all.dataset.playAll ?? '')).map(itemOf).filter((i): i is Item => !!i);
      playList(items, 0);
      return;
    }
    const random = target.closest<HTMLElement>('[data-play-random]');
    if (random) {
      random.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`/api/random?lang=${encodeURIComponent(document.documentElement.lang)}`, { headers: { accept: 'application/json' } });
        const items = res.ok ? ((await res.json()) as Item[]) : [];
        if (items.length) playList(items, 0);
        else toast(L.nothing);
      } finally {
        random.removeAttribute('aria-busy');
      }
    }
  });

  // The public site swaps pages in place: mark the playing track on each new page.
  document.addEventListener('astro:page-load', highlight);
  window.addEventListener('pagehide', () => save(true));

  // What this browser was playing last time, ready to go on where it stopped.
  audio.volume = state.volume;
  volume.value = String(state.volume);
  reorder(state.shuffle);
  render();
}
