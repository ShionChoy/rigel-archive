// Addresses of the public site's pages (设计文档「公开站方案 · 页面与网址」): every page exists once per
// language, /zh/…, /ja/…, /en/…; `/` sends visitors to theirs.

import { isSiteLang, type SiteLang } from '../i18n';

export const siteLangOf = (lang: string): SiteLang => (isSiteLang(lang) ? lang : 'zh');

/** The language an address is in (its first segment), or null. */
export function langOfPath(pathname: string): SiteLang | null {
  const first = pathname.split('/')[1];
  return isSiteLang(first) ? first : null;
}

export function pagesFor(lang: SiteLang) {
  const q = (params: Record<string, string | null | undefined>) => {
    const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
    return s ? `?${s}` : '';
  };
  return {
    home: `/${lang}/`,
    works: (params: Record<string, string | null | undefined> = {}) => `/${lang}/works/${q(params)}`,
    work: (id: string, edition?: string | null) => `/${lang}/works/${encodeURIComponent(id)}/${q({ edition })}`,
    song: (id: string) => `/${lang}/songs/${encodeURIComponent(id)}/`,
    about: `/${lang}/about/`,
  };
}

/** This page in another language. */
export function inLang(url: URL, lang: SiteLang): string {
  const rest = langOfPath(url.pathname) ? url.pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '') : url.pathname;
  return `/${lang}${rest || '/'}${url.search}`;
}
