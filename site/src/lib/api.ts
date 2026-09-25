
import { UserError } from './i18n';// Helpers for the JSON endpoints under /admin/api (used by the upload page and by `ra worker`).

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function blobKey(sha256: string): string {
  return `blobs/${sha256}`;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Browser calls to the admin API must come from the admin pages: they send a custom header (which a
 * cross-site page cannot add without a CORS preflight we never allow) and, when present, our Origin.
 * Astro's own origin check only covers form posts, not JSON or raw uploads.
 */
export function fromAdminPage(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return request.headers.get('x-admin-request') === '1' && (origin === null || origin === url.origin);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UserError('请求内容不是有效的 JSON');
}

// Stored files are opened from the admin's own origin. Web pages, SVG and XML in the 合辑 (old blogs,
// web archives) may carry scripts: they are shown in a sandbox, a unique origin with scripts off, so
// they cannot act with the admin's session. PDFs are left alone (browsers refuse to show them sandboxed).
const ACTIVE_TYPES = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript)/i;

function protect(headers: Headers) {
  headers.set('x-content-type-options', 'nosniff');
  if (ACTIVE_TYPES.test(headers.get('content-type') ?? '')) headers.set('content-security-policy', 'sandbox');
}

/** Serve an R2 object with Range support (audio/video seeking) and conditional requests. */
export async function serveObject(media: R2Bucket, key: string, request: Request, download?: string): Promise<Response> {
  const head = request.method === 'HEAD';
  const object = head
    ? await media.head(key)
    : await media.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response('找不到文件', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (download) headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download)}`);
  protect(headers);
  if (head || !('body' in object)) {
    headers.set('content-length', String(object.size));
    return new Response(null, { status: head ? 200 : 304, headers });
  }
  const body = (object as R2ObjectBody).body;
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has('range')) {
    const start = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix ?? range.length ?? object.size - start;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(body, { status: 200, headers });
}
