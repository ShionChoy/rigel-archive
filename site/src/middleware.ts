import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { route } from './lib/hosts';
import { isLang, langFromHeader, translator, type Lang } from './lib/i18n';
import { cachedPage } from './lib/public/cache';
import { langOfPath } from './lib/public/paths';
import { SITE } from './lib/site';

type Admin = NonNullable<App.Locals['admin']>;

const DEV_ADMIN: Admin = { email: 'dev@localhost', name: '本地开发', role: 'owner', lang: null };

/** The admin's own setting, else the language chosen on this browser, else the browser's language. */
function chooseLang(admin: Admin, request: Request, cookie: string | undefined): Lang {
  if (isLang(admin.lang)) return admin.lang;
  if (isLang(cookie)) return cookie;
  return langFromHeader(request.headers.get('accept-language'));
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * /admin sits behind Cloudflare Access. Access has already logged the user in; we verify its JWT and
 * then require the email to be on the site's own admins list. Without ACCESS_* settings the admin is
 * closed everywhere except `astro dev`. ACCESS_AUD may name several Access applications (comma-separated),
 * e.g. the admin's host and an older preview host while moving from one to the other.
 */
async function adminFromAccess(request: Request): Promise<Admin | null> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = (env.ACCESS_AUD ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!team || !audience.length || !token) return null;
  jwks ??= createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience });
    if (typeof payload.email !== 'string') return null;
    return await env.DB.prepare('SELECT email, name, role, lang FROM admins WHERE email = ?')
      .bind(payload.email.toLowerCase())
      .first<Admin>();
  } catch {
    return null;
  }
}

const WORKER: Admin = { email: 'ra-worker', name: '处理程序', role: 'worker', lang: 'zh' };

/** `ra worker` authenticates with WORKER_TOKEN, and only for /admin/api/worker/*. */
function workerToken(request: Request): boolean {
  const expected = env.WORKER_TOKEN;
  const given = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!expected || given.length !== expected.length) return false;
  let diff = 0; // constant time, so the token cannot be guessed character by character
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** On the site's own hosts browsers are told to keep to HTTPS (not its subdomains: they may be other services later). */
const HSTS = 'max-age=31536000';

/** Headers of every public page: never framed by other sites, file names not leaked, kept out of search engines until launch. */
function publicHeaders(given: Response, ours: boolean): Response {
  // A copy: responses from the edge cache and redirects have headers that cannot be changed.
  const response = new Response(given.body, given);
  if (ours) response.headers.set('strict-transport-security', HSTS);
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  if (SITE.noindex) response.headers.set('x-robots-tag', 'noindex');
  return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  context.locals.lang = langFromHeader(context.request.headers.get('accept-language'));
  context.locals.t = translator(context.locals.lang);

  // Which host: the public site (rigeltheatre.fans), the admin (admin.…), or anywhere else (both; lib/hosts.ts).
  const where = route(context.url, { public: env.PUBLIC_HOST ?? '', admin: env.ADMIN_HOST ?? '' });
  if ('redirect' in where) return new Response(null, { status: where.status, headers: { location: where.redirect, 'cache-control': 'public, max-age=3600' } });
  if ('notFound' in where) {
    const response = await context.rewrite('/404');
    return publicHeaders(new Response(response.body, { status: 404, headers: response.headers }), true);
  }

  // The public site: /zh/…, /ja/…, /en/… (lib/public/paths.ts), kept at the edge (lib/public/cache.ts).
  const siteLang = langOfPath(path);
  if (siteLang) {
    context.locals.lang = siteLang;
    context.locals.t = translator(siteLang);
    return publicHeaders(await cachedPage(context.request, context.url, context.locals.cfContext?.waitUntil.bind(context.locals.cfContext), () => next()), where.ours);
  }
  if (path !== '/admin' && !path.startsWith('/admin/')) return publicHeaders(await next(), where.ours);

  if (path.startsWith('/admin/api/worker/')) {
    // In production Cloudflare Access also sits in front; the worker passes a service token there.
    if (!workerToken(context.request)) return new Response('需要处理程序令牌', { status: 403 });
    context.locals.admin = WORKER;
    context.locals.lang = 'zh';
    context.locals.t = translator('zh');
    const response = await next();
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  const admin = import.meta.env.DEV ? DEV_ADMIN : await adminFromAccess(context.request);
  if (!admin) {
    return new Response(context.locals.t('需要管理组权限'), { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  context.locals.admin = admin;
  const lang = chooseLang(admin, context.request, context.cookies.get('admin_lang')?.value);
  context.locals.lang = lang;
  context.locals.t = translator(lang);
  const response = await next();
  response.headers.set('cache-control', 'no-store');
  // The admin is never framed by other sites, and never leaks its URLs (file names) to them.
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  response.headers.set('referrer-policy', 'same-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  if (where.ours) response.headers.set('strict-transport-security', HSTS);
  return response;
});
