// Waveforms under audio players: the peaks made by the processing program (derived/wave/<sha>.json),
// drawn on a canvas that shows the position and seeks on click.

interface Wave {
  duration: number;
  peaks: number[]; // 0–255
}

function draw(canvas: HTMLCanvasElement, wave: Wave, played: number) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  const bars = Math.max(1, Math.floor(width / 2));
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor((i / bars) * wave.peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * wave.peaks.length));
    const peak = Math.max(...wave.peaks.slice(from, to)) / 255;
    const h = Math.max(1, peak * (height - 2));
    ctx.fillStyle = i / bars <= played ? style.getPropertyValue('--wave-played') || '#3c5aa8' : style.getPropertyValue('--wave') || '#b9bfd0';
    ctx.fillRect(i * 2, (height - h) / 2, 1.5, h);
  }
}

/** Every [data-wave] canvas under root; its data-audio names the player (an element id). */
export function initWaveforms(root: ParentNode) {
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas[data-wave]')) {
    const audio = document.getElementById(canvas.dataset.audio ?? '') as HTMLAudioElement | null;
    fetch(canvas.dataset.wave!)
      .then((res) => (res.ok ? (res.json() as Promise<Wave>) : Promise.reject(res.status)))
      .then((wave) => {
        const played = () => (audio && audio.duration ? audio.currentTime / audio.duration : 0);
        const redraw = () => draw(canvas, wave, played());
        redraw();
        audio?.addEventListener('timeupdate', redraw);
        new ResizeObserver(redraw).observe(canvas);
        canvas.addEventListener('click', (e) => {
          if (!audio) return;
          const at = (e.offsetX / canvas.clientWidth) * (audio.duration || wave.duration);
          audio.currentTime = at;
          if (audio.paused) audio.play().catch(() => {});
        });
      })
      .catch(() => canvas.remove());
  }
}
