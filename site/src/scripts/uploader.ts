// Browser side of storing files (the upload page and 「上传新版本」 on the file page): hash with
// SHA-256, then store under blobs/<sha256> in one request or in parts. Parts already sent are
// remembered in this browser, so choosing the same file again after a failure or a reload continues
// where it stopped (断点续传).

import { createSHA256 } from 'hash-wasm';
import { mimeFor } from '../lib/constants';
import { t } from './i18n';

// Parts (and whole small files) stay well under the 100 MB request body limit of Workers.
export const PART = 50 * 1024 * 1024;
const READ = 8 * 1024 * 1024;
const TRIES = 3;

type Part = { partNumber: number; etag: string };

export async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-request': '1' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ? t(data.error) : `HTTP ${response.status}`);
  return data as T;
}

/** Browsers leave the type empty for many formats (FLAC, BMS…), so go by the extension first. */
export function contentType(file: File): string {
  const dot = file.name.lastIndexOf('.');
  const byExt = dot > 0 ? mimeFor(file.name.slice(dot + 1)) : 'application/octet-stream';
  return byExt !== 'application/octet-stream' ? byExt : file.type || byExt;
}

/** PUT with upload progress (fetch cannot report it). */
function put<T>(url: string, blob: Blob, type: string, onProgress: (loaded: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-admin-request', '1');
    xhr.setRequestHeader('content-type', type);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // keep the status code message
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(Object.assign(new Error(data.error ? t(data.error) : `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error(t('网络错误')), { status: 0 }));
    xhr.send(blob);
  });
}

/** Retry network errors and server hiccups (not refusals) a few times. */
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (attempt >= TRIES || (status >= 400 && status < 500 && status !== 429)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

export async function hashFile(file: File, onProgress: (done: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += READ) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + READ).arrayBuffer()));
    onProgress(Math.min(offset + READ, file.size) / file.size);
  }
  return hasher.digest('hex');
}

const memoKey = (sha: string) => `rigel-upload:${sha}`;
function recall(sha: string): { uploadId: string; parts: Part[] } | null {
  try {
    return JSON.parse(localStorage.getItem(memoKey(sha)) ?? 'null');
  } catch {
    return null;
  }
}
function remember(sha: string, value: { uploadId: string; parts: Part[] } | null) {
  try {
    if (value) localStorage.setItem(memoKey(sha), JSON.stringify(value));
    else localStorage.removeItem(memoKey(sha));
  } catch {
    // private mode: no resuming, uploads still work
  }
}

/** Store the file's content (already hashed) under blobs/<sha>; `progress` gets the bytes sent so far. */
export async function storeFile(file: File, sha: string, progress: (loaded: number) => void): Promise<void> {
  const type = contentType(file);
  if (file.size <= PART) {
    await retrying(() => put(`/admin/api/upload/blob/${sha}`, file, type, progress));
    return;
  }
  const base = `/admin/api/upload/multipart/${sha}`;
  let memo = recall(sha);
  if (!memo) {
    const { uploadId } = await retrying(() => call<{ uploadId: string }>(base, { action: 'create', contentType: type }));
    memo = { uploadId, parts: [] };
    remember(sha, memo);
  }
  const done = new Map(memo.parts.map((p) => [p.partNumber, p]));
  for (let n = 1, offset = 0; offset < file.size; n += 1, offset += PART) {
    if (done.has(n)) continue;
    let part: Part;
    try {
      part = await retrying(() =>
        put<Part>(`${base}?uploadId=${encodeURIComponent(memo!.uploadId)}&part=${n}`, file.slice(offset, offset + PART),
          'application/octet-stream', (loaded) => progress(offset + loaded)),
      );
    } catch (e) {
      if (done.size > 0 && (e as { status?: number }).status === 400) {
        remember(sha, null); // the earlier upload expired in storage: start again from the first part
        return storeFile(file, sha, progress);
      }
      throw e; // parts sent so far stay remembered for the next attempt
    }
    done.set(n, { partNumber: part.partNumber, etag: part.etag });
    remember(sha, { uploadId: memo.uploadId, parts: [...done.values()] });
    progress(Math.min(offset + PART, file.size));
  }
  await retrying(() => call(base, { action: 'complete', uploadId: memo!.uploadId, parts: [...done.values()].sort((a, b) => a.partNumber - b.partNumber) }));
  remember(sha, null);
}
