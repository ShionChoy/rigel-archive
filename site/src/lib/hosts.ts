// The site's addresses (wrangler.jsonc PUBLIC_HOST, ADMIN_HOST): the public site at the domain itself, the
// admin at admin.<domain> (the whole host behind Cloudflare Access), www.<domain> sent on to the domain.
// Any other host — astro dev, the processing container's http://site.internal, a workers.dev preview —
// serves everything, as before the site had a domain. Pure, so it is tested on its own (tests/hosts.test.ts).

export interface Hosts {
  public: string;
  admin: string;
}

export type Route =
  | { redirect: string; status: 301 | 302 }
  | { notFound: true }
  /** `ours`: one of the site's own hosts (always HTTPS, so browsers are told to keep to it). */
  | { serve: 'public' | 'admin' | 'any'; ours: boolean };

const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');

export function route(url: URL, hosts: Hosts): Route {
  const host = url.hostname.toLowerCase();
  const www = `www.${hosts.public}`;
  if (!hosts.public || !hosts.admin || (host !== hosts.public && host !== hosts.admin && host !== www)) return { serve: 'any', ours: false };
  const rest = `${url.pathname}${url.search}`;
  if (host === www) return { redirect: `https://${hosts.public}${rest}`, status: 301 };
  if (url.protocol === 'http:') return { redirect: `https://${host}${rest}`, status: 301 };
  if (host === hosts.public) return isAdminPath(url.pathname) ? { notFound: true } : { serve: 'public', ours: true };
  // The admin's host: the admin itself; its home is /admin/, and links to public pages go to the public site.
  if (isAdminPath(url.pathname)) return { serve: 'admin', ours: true };
  if (url.pathname === '/') return { redirect: `https://${hosts.admin}/admin/`, status: 302 };
  return { redirect: `https://${hosts.public}${rest}`, status: 301 };
}
