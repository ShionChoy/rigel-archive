// 正在播放: the big view of the track playing (components/Player.astro #now-playing), opened from the
// player's cover. The player (scripts/player.ts) stays the remote at the bottom; this view shows the
// cover at full size, the title and credits, and the lyrics (lib/lyrics.ts), asked for by file from the
// page's track endpoint (data-info: /api/track, or the admin's for 预览公开页).
//
//   synced lyrics   the line playing is lit and kept in the middle (not for a few seconds after the visitor
//                   scrolls them); a click on a line goes there (not in a preview clip)
//   plain lyrics    shown as they are, with a note that they do not follow the music
//   no lyrics       the cover alone in the middle, with the title and credits under it
// On a phone the cover and the lyrics take turns (tabs). Above the player a thin waveform of the track drifts
// by as it plays (the peaks the processing program measured, tools/ra derive.py; the sound itself is not
// touched): what has played a little brighter, what is to come faint, the moment playing brightest, both
// ends fading out. Its bars rank each moment's loudness within the track, so quiet verses sit low and the
// loud parts stand tall as the music goes on.
//
// The view is a step in the browser's history, so Back (a phone's back gesture) closes it. The site's router
// (Astro ClientRouter) skips history steps without a state; while the view is open the page's own step has
// none (it is put back on closing), so Back is left to the view and the page under it stays as it is.

import { lineAt, type LyricLine, type Lyrics } from '../lib/lyrics';

export interface NowItem { file: string | null; title: string; sub: string; album: string; cover: string | null; href: string | null }
export interface Host {
  current(): NowItem | undefined;
  /** Where the track playing is (seconds of the whole track, a preview clip's start added). */
  time(): number;
  /** Lines can be clicked to go there (not in a preview clip). */
  canSeek(): boolean;
  seek(seconds: number): void;
}
interface Info { lyrics: Lyrics | null; artist: string; credits: [string, string][]; art: string | null; wave: { duration?: number; peaks?: number[] } | null }
/** A track's waveform: how loud (0–1) each of its equal slices of `duration` seconds is, for the bars. */
interface Wave { duration: number; levels: number[] }

/** How long the lyrics stay where the visitor scrolled them before following the music again (ms). */
const HOLD = 4000;
/** The waveform: a bar every SLOT px, BAR px wide, drifting by at this many px a second (phones slower). */
const SLOT = 6;
const BAR = 2;
/** Bars this close to the moment playing (seconds) are lit up. */
const NEAR = 1.6;
const DRIFT = { wide: 32, narrow: 24 };

export function setUpNowPlaying(host: Host) {
  const box = document.getElementById('now-playing');
  const player = document.getElementById('player');
  if (!box || !player) return { update() {}, open() {}, prefetch() {} };
  const view = box;
  const L = JSON.parse(view.dataset.labels ?? '{}') as Record<string, string>;
  const endpoint = view.dataset.info || '/api/track';
  const $ = <E extends Element>(sel: string) => view.querySelector<E>(sel)!;
  const scroller = $<HTMLElement>('.np-lyrics');
  const list = $<HTMLElement>('.np-lines');
  const art = $<HTMLImageElement>('.np-cover');
  const canvas = $<HTMLCanvasElement>('.np-wave');
  const backdrop = $<HTMLImageElement>('.np-bg img');
  const album = $<HTMLAnchorElement>('.np-album');
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cache = new Map<string, Promise<Info | null>>();
  /** Details already here, by file: drawn at once, without waiting a turn. */
  const known = new Map<string, Info | null>();
  let opened = false;
  /** The view is opening: until the details are here (or a moment has passed) its body stays hidden. */
  let opening = 0;
  let drawnFile: string | null | undefined;
  let info: Info | null = null;
  let artSrc: string | null = null;
  let active = -2;
  let holdUntil = 0;
  /** The lit line moved while the visitor held the lyrics: bring it to the middle once they let go. */
  let behind = false;
  let frame = 0;
  let wave: Wave | null = null;
  /** What the waveform was last drawn for (track time, width), so a paused track is not drawn again and again. */
  let drawn = { at: NaN, width: 0, when: 0 };
  let afterClose: (() => void) | null = null;
  let returnTo: HTMLElement | null = null;
  /** The page's own history state, kept while the view's step is on top of it. */
  let saved: unknown = null;

  // The player's height, for the room the view leaves it at the bottom.
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--pl-h', `${player.offsetHeight}px`);
  }).observe(player);

  // ------------------------------------------------------------ the track's details
  function fetchInfo(file: string): Promise<Info | null> {
    let found = cache.get(file);
    if (!found) {
      const lang = document.documentElement.lang || '';
      found = fetch(`${endpoint}?f=${encodeURIComponent(file)}&lang=${encodeURIComponent(lang)}`, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<Info>) : null))
        .catch(() => null);
      cache.set(file, found);
      found.then((x) => {
        known.set(file, x);
        // A failed request is asked again next time.
        if (!x) {
          cache.delete(file);
          known.delete(file);
        }
      });
    }
    return found;
  }

  /** Show the cover `src`: the player's own at once (it is loaded already); a larger one (`upgrade`) once it is ready. */
  function setArt(src: string | null, upgrade = false) {
    if (src === artSrc) return;
    artSrc = src;
    view.classList.toggle('no-art', !src);
    if (!src) {
      art.removeAttribute('src');
      return;
    }
    if (!upgrade) {
      art.src = src;
      return;
    }
    // The larger cover replaces the smaller one once it is ready, without a blank in between.
    const next = new Image();
    next.src = src;
    next.decode().catch(() => undefined).finally(() => {
      if (artSrc === src) art.src = src;
    });
  }

  /** The title, the cover and (once they are here) the lyrics of the track playing. */
  function draw() {
    const item = host.current();
    if (!item) return;
    $('.np-title').textContent = item.title;
    album.textContent = item.album;
    if (item.href) album.href = item.href;
    else album.removeAttribute('href');
    if (item.file === drawnFile) return;
    drawnFile = item.file;
    info = null;
    if (item.cover) backdrop.src = item.cover;
    else backdrop.removeAttribute('src');
    setArt(item.cover);
    setWave(null);
    const file = item.file;
    const show = (found: Info | null) => {
      // A body that waited hidden fades in as a whole.
      const quiet = view.classList.contains('pending');
      view.classList.remove('waiting', 'pending');
      clearTimeout(opening);
      opening = 0;
      info = found;
      if (found?.art) setArt(found.art, true);
      drawInfo(quiet);
      setWave(prepareWave(found?.wave ?? null));
    };
    if (!file) return show(null);
    if (known.has(file)) return show(known.get(file) ?? null);
    // Until the details are here the layout stays as it was (what was there fades out), so a track with
    // lyrics after one with lyrics does not jump to the cover alone and back. A view just opening has no
    // layout yet: its body waits hidden, a moment at most.
    view.classList.add(opening ? 'pending' : 'waiting');
    if (opening) {
      opening = window.setTimeout(() => {
        opening = 0;
        if (view.classList.contains('pending')) {
          view.classList.replace('pending', 'waiting');
          drawInfo();
        }
      }, 900);
    }
    fetchInfo(file).then((found) => {
      if (drawnFile === file) show(found);
    });
  }

  function drawInfo(quiet = false) {
    const lyrics = info?.lyrics ?? null;
    $('.np-artist').textContent = info ? info.artist : host.current()?.sub ?? '';
    // The layout changes (cover alone, or cover and lyrics): fade the new one in.
    if (opened && !quiet && view.classList.contains('has-lyrics') !== !!lyrics && !reduce()) {
      $('.np-body').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
    }
    view.classList.toggle('has-lyrics', !!lyrics);
    view.classList.toggle('synced', !!lyrics?.synced);
    if (!lyrics) {
      view.classList.remove('tab-lyrics');
      for (const b of Array.from(view.querySelectorAll('[data-np-tab]'))) b.setAttribute('aria-selected', String(b.getAttribute('data-np-tab') === 'cover'));
    }
    const credits = $<HTMLElement>('.np-credits');
    credits.replaceChildren(...(info?.credits ?? []).map(([k, v]) => {
      const row = document.createElement('div');
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = k;
      const value = document.createElement('span');
      value.textContent = v;
      row.appendChild(key);
      row.appendChild(value);
      return row;
    }));
    $('.np-note').textContent = lyrics && !lyrics.synced ? L.unsynced : '';
    list.replaceChildren(...(lyrics?.lines ?? []).map((line, i) => lineElement(line, i, !!lyrics?.synced)));
    active = -2;
    scroller.scrollTop = 0;
    if (lyrics?.synced) follow(true);
  }

  function lineElement(line: LyricLine, i: number, synced: boolean): HTMLElement {
    const p = document.createElement('p');
    p.className = line.text ? 'np-line' : synced ? 'np-line gap' : 'np-break';
    p.dataset.i = String(i);
    if (!line.text) return p;
    p.textContent = line.text;
    for (const tr of line.tr ?? []) {
      const span = document.createElement('span');
      span.className = 'tr';
      span.textContent = tr;
      p.appendChild(span);
    }
    return p;
  }

  // ------------------------------------------------------------ the waveform
  /**
   * Loud masters peak near the top almost everywhere, so a peak's height alone draws a flat band. Each
   * moment's rank among the track's own peaks (mostly), with its level between the track's quiet and loud
   * ends, spreads the bars out while louder still means taller.
   */
  function prepareWave(raw: { duration?: number; peaks?: number[] } | null): Wave | null {
    const peaks = raw?.peaks;
    if (!Array.isArray(peaks) || peaks.length < 2 || !(Number(raw?.duration) > 0)) return null;
    const sorted = [...peaks].sort((a, b) => a - b);
    const n = sorted.length;
    const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
    const lo = at(0.05);
    const hi = Math.max(at(0.995), lo + 8);
    /** The share of the track quieter than `v` (ties count half). */
    const rank = (v: number) => {
      let below = 0;
      let upTo = n;
      for (let a = 0, b = n; a < b;) {
        const m = (a + b) >> 1;
        if (sorted[m] < v) a = below = m + 1;
        else b = m;
      }
      for (let a = below, b = n; a < b;) {
        const m = (a + b) >> 1;
        if (sorted[m] <= v) a = m + 1;
        else b = upTo = m;
      }
      return (below + (upTo - below) / 2) / n;
    };
    const levels = peaks.map((v) => 0.35 * Math.min(1, Math.max(0, (v - lo) / (hi - lo))) + 0.65 * rank(v));
    return { duration: Number(raw!.duration), levels };
  }
  function setWave(w: Wave | null) {
    wave = w;
    view.classList.toggle('has-wave', !!w);
    drawn = { at: NaN, width: 0, when: 0 };
  }
  function drawWave() {
    if (!wave) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const now = host.time();
    // Still (paused) or barely moved: nothing to draw. Without motion wanted: once a second.
    if (drawn.width === width && (Math.abs(now - drawn.at) < 0.004 || (reduce() && Date.now() - drawn.when < 1000))) return;
    drawn = { at: now, width, when: Date.now() };
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { duration, levels } = wave;
    const speed = matchMedia('(max-width: 760px)').matches ? DRIFT.narrow : DRIFT.wide;
    const step = SLOT / speed; // seconds a bar stands for
    const half = width / 2;
    // Bars sit on fixed moments of the track, so they glide instead of flickering.
    for (let k = Math.floor((now - half / speed) / step); k <= Math.ceil((now + half / speed) / step); k += 1) {
      const t = k * step;
      if (t < 0 || t > duration) continue;
      const at = (t / duration) * (levels.length - 1);
      const i = Math.floor(at);
      const level = levels[i] + (levels[Math.min(i + 1, levels.length - 1)] - levels[i]) * (at - i);
      const h = Math.max(2, (0.06 + 0.94 * level ** 1.5) * height);
      const x = half + (t - now) * speed - BAR / 2;
      // Played bars brighter than coming ones; those at the moment playing brightest of all.
      const near = Math.max(0, 1 - Math.abs(t - now) / NEAR);
      const alpha = (t <= now ? 0.42 : 0.16) + near * (t <= now ? 0.48 : 0.34);
      ctx.fillStyle = `rgb(255 255 255 / ${alpha.toFixed(3)})`;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, (height - h) / 2, BAR, h, BAR / 2);
      else ctx.rect(x, (height - h) / 2, BAR, h);
      ctx.fill();
    }
  }

  // ------------------------------------------------------------ following the music
  /** Light the line playing and keep it in the middle; `jump` moves there at once. */
  function follow(jump = false) {
    const lyrics = info?.lyrics;
    if (!lyrics?.synced) return;
    const now = lineAt(lyrics.lines, host.time() + 0.15);
    if (now === active && !jump) {
      if (behind && Date.now() >= holdUntil) {
        behind = false;
        center(list.querySelector<HTMLElement>('.np-line.on'), false);
      }
      return;
    }
    list.querySelector('.np-line.on')?.classList.remove('on');
    const el = now >= 0 ? list.querySelector<HTMLElement>(`[data-i="${now}"]`) : null;
    el?.classList.add('on');
    active = now;
    behind = !jump && Date.now() < holdUntil;
    if (!behind) center(el, jump);
  }
  function center(el: HTMLElement | null, jump: boolean) {
    if (!el) return;
    const top = el.offsetTop - (scroller.clientHeight - el.offsetHeight) / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: jump || reduce() ? 'auto' : 'smooth' });
  }
  function tick() {
    follow();
    drawWave();
    frame = requestAnimationFrame(tick);
  }
  const startFollowing = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const stopFollowing = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  for (const type of ['wheel', 'touchmove', 'keydown']) {
    scroller.addEventListener(type, () => {
      holdUntil = Date.now() + HOLD;
    }, { passive: true });
  }
  list.addEventListener('click', (e) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>('.np-line');
    const t = line ? info?.lyrics?.lines[Number(line.dataset.i)]?.t : null;
    if (t == null || !info?.lyrics?.synced || !host.canSeek()) return;
    holdUntil = 0;
    behind = false;
    host.seek(t);
  });

  // ------------------------------------------------------------ opening and closing
  /** Everything but the player and this view, while the view covers it. */
  function setInert(on: boolean) {
    for (const el of Array.from(document.body.children)) {
      if (el === view || el === player || el.contains(view) || el.contains(player) || el.tagName === 'SCRIPT') continue;
      if (on && !el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        el.setAttribute('data-np-inert', '');
      } else if (!on && el.hasAttribute('data-np-inert')) {
        el.removeAttribute('inert');
        el.removeAttribute('data-np-inert');
      }
    }
  }

  function open(step = true) {
    if (opened || !host.current()) return;
    opened = true;
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    view.hidden = false;
    opening = -1;
    draw();
    if (opening === -1) opening = 0;
    void view.offsetWidth; // start the opening transition from the closed state
    view.classList.add('on');
    document.documentElement.classList.add('np-open');
    setInert(true);
    if (step) {
      saved = history.state;
      history.replaceState(null, '');
      history.pushState({ ...(saved ?? {}), nowPlaying: true }, '');
    }
    $<HTMLElement>('.np-close').focus({ preventScroll: true });
    follow(true);
    startFollowing();
  }

  function hide() {
    if (!opened) return;
    opened = false;
    clearTimeout(opening);
    opening = 0;
    view.classList.remove('pending');
    stopFollowing();
    view.classList.remove('on');
    document.documentElement.classList.remove('np-open');
    setInert(false);
    const done = () => {
      if (!opened) view.hidden = true;
    };
    if (reduce()) done();
    else setTimeout(done, 300);
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    returnTo = null;
  }

  /** Close the view (taking its step back out of the history), then `then`. */
  function close(then?: () => void) {
    if (!opened) return then?.();
    if (history.state?.nowPlaying) {
      afterClose = then ?? null;
      history.back();
    } else {
      hide();
      then?.();
    }
  }

  window.addEventListener('popstate', (e) => {
    if (!opened || (e.state as { nowPlaying?: boolean } | null)?.nowPlaying) return;
    // Back while the view is open (the router skipped this step, it has no state): close it and give the
    // page its state back. Forward again later is the router's (it shows the same page again).
    if (history.state === null && saved) history.replaceState(saved, '');
    saved = null;
    hide();
    const then = afterClose;
    afterClose = null;
    then?.();
  });
  // Leaving the page some other way: the view goes with it.
  document.addEventListener('astro:before-preparation', hide);

  $('.np-close').addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !opened) return;
    // The player's menus close first (scripts/player.ts).
    if (document.querySelector('.pl-qmenu:not([hidden]), .pl-queue:not([hidden])')) return;
    close();
  });
  // The album link: close first, then go (so the history holds no step of the view).
  album.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !album.href) return;
    e.preventDefault();
    const href = album.href;
    close(() => {
      if (href === location.href) return;
      const a = document.createElement('a');
      a.href = href;
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });
  // On a phone the cover and the lyrics take turns.
  view.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-np-tab]');
    if (!tab) return;
    const lyrics = tab.dataset.npTab === 'lyrics';
    view.classList.toggle('tab-lyrics', lyrics);
    for (const b of Array.from(view.querySelectorAll<HTMLButtonElement>('[data-np-tab]'))) b.setAttribute('aria-selected', String(b === tab));
    if (lyrics) follow(true);
  });

  return {
    /** The player changed (another track, nothing left): show it. */
    update() {
      if (!opened) return;
      if (!host.current()) close();
      else draw();
    },
    open: () => open(),
    /** Ask for the track's details before the view opens (the cover is pointed at). */
    prefetch() {
      const file = host.current()?.file;
      if (file) fetchInfo(file);
    },
  };
}
