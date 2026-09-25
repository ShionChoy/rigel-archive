import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isLang, langFromHeader, translator, type Lang } from './lib/i18n';

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
 * closed everywhere except `astro dev`.
 */
async function adminFromAccess(request: Request): Promise<Admin | null> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!team || !audience || !token) return null;
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

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  context.locals.lang = langFromHeader(context.request.headers.get('accept-language'));
  context.locals.t = translator(context.locals.lang);
  if (path !== '/admin' && !path.startsWith('/admin/')) return next();

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
  return response;
});
