export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatTime(iso: string): string {
  // Stored in UTC; admins are mostly in UTC+8/+9, so show the date and minutes with a UTC mark.
  return iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
}

export function percent(value: number | null | undefined): string {
  return value == null ? '' : `${Math.round(value * 100)}%`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const CODEC_NAMES: Record<string, string> = {
  flac: 'FLAC', alac: 'ALAC', mp3: 'MP3', aac: 'AAC', vorbis: 'Vorbis', opus: 'Opus', wmav2: 'WMA',
  h264: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', wmv3: 'WMV',
  mjpeg: 'JPEG', png: 'PNG', bmp: 'BMP', gif: 'GIF', webp: 'WebP', tiff: 'TIFF',
};

export function codecName(codec: string | undefined): string {
  if (!codec) return '';
  if (codec.startsWith('pcm_')) return 'PCM';
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

/** One-line spec for lists: "FLAC 24/96 · 4:32", "H.264 1920×1080 · 3:45", "PNG 1400×1400". */
export function formatSpec(f: {
  codec?: string; bits?: number; rate?: number; lossless?: boolean; kbps?: number; duration?: number;
  vcodec?: string; width?: number; height?: number;
}): string {
  const parts: string[] = [];
  if (f.vcodec) parts.push(`${codecName(f.vcodec)} ${f.width}×${f.height}`);
  else if (f.width && f.height) parts.push(`${codecName(f.codec)} ${f.width}×${f.height}`);
  else if (f.codec) {
    const rate = f.rate ? `${+(f.rate / 1000).toFixed(1)}` : '';
    parts.push(f.lossless ? `${codecName(f.codec)} ${f.bits ?? '?'}/${rate}` : `${codecName(f.codec)} ${f.kbps ?? '?'}k`);
  }
  if (f.duration) parts.push(formatDuration(f.duration));
  return parts.join(' · ');
}

/** Rebuild the current URL with some query parameters changed (null removes one). */
export function withParams(url: URL, changes: Record<string, string | number | null | undefined>): string {
  const next = new URL(url);
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === '') next.searchParams.delete(k);
    else next.searchParams.set(k, String(v));
  }
  return next.pathname + next.search;
}
