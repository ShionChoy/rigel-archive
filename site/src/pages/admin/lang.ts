import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isLang } from '../../lib/i18n';

/**
 * The language buttons in the admin's side bar. Saved on the admin's own entry (so it follows them to
 * other browsers) and in a cookie (the local dev admin has no entry).
 */
export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  const form = await request.formData();
  const lang = form.get('lang');
  const back = String(form.get('back') ?? '');
  const target = back.startsWith('/admin') && !back.startsWith('//') ? back : '/admin/inbox';
  if (!isLang(lang)) return redirect(target, 303);
  cookies.set('admin_lang', lang, { path: '/admin', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 365 * 86400 });
  if (locals.admin && locals.admin.role !== 'worker') {
    await env.DB.prepare('UPDATE admins SET lang = ? WHERE email = ?').bind(lang, locals.admin.email).run();
  }
  const url = new URL(target, request.url);
  url.searchParams.delete('msg');
  url.searchParams.delete('err');
  return redirect(url.pathname + url.search, 303);
};
