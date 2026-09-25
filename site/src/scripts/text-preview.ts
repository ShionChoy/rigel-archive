// Text files in previews: read the first 512 KB, guess the encoding, let the admin switch it.

import { t } from './i18n';

const MAX_BYTES = 512 * 1024;

function detect(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return 'utf-8';
  } catch {
    return 'shift_jis'; // most non-UTF-8 text in the archive is Japanese; switch by hand for GBK/Big5 CUE files
  }
}

/** Fill every [data-text-src] box under root (the file page, or a preview loaded into the 整理台). */
export function initTextPreviews(root: ParentNode) {
  for (const box of root.querySelectorAll<HTMLElement>('[data-text-src]')) {
    const select = box.querySelector('select')!;
    const pre = box.querySelector('pre')!;
    const note = box.querySelector<HTMLElement>('[data-detected]')!;
    let bytes: Uint8Array | null = null;
    let detected = 'utf-8';
    const render = () => {
      if (!bytes) return;
      const encoding = select.value === 'auto' ? detected : select.value;
      pre.textContent = new TextDecoder(encoding).decode(bytes);
      note.textContent = select.value === 'auto' ? t('（识别为 {encoding}）', { encoding: detected }) : '';
    };
    select.addEventListener('change', render);
    fetch(box.dataset.textSrc!, { headers: { Range: `bytes=0-${MAX_BYTES - 1}` } })
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        bytes = new Uint8Array(buffer);
        detected = detect(bytes);
        render();
      })
      .catch((error) => (pre.textContent = t('读取失败：{error}', { error: String(error) })));
  }
}
