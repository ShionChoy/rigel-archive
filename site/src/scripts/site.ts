// The public site's own bits of behaviour (layouts/Site.astro), set up once per visit: the page is swapped
// in place by Astro's router, so everything listens on the document.
//
//   theme     dark by default; a visitor's choice of light is kept in localStorage rigel.site.theme
//   language  the language last used is kept in a cookie, so `/` sends the visitor back to it
//   filters   a GET form marked data-auto-submit goes to its results as soon as a choice changes

import { navigate } from 'astro:transitions/client';

const THEME = 'rigel.site.theme';

function applyTheme(doc: Document = document) {
  let light = false;
  try {
    light = localStorage.getItem(THEME) === 'light';
  } catch {
    // no storage: dark
  }
  if (light) doc.documentElement.dataset.theme = 'light';
  else delete doc.documentElement.dataset.theme;
}

function rememberLanguage() {
  const lang = location.pathname.split('/')[1];
  if (['zh', 'ja', 'en'].includes(lang)) document.cookie = `site_lang=${lang}; path=/; max-age=31536000; samesite=lax`;
}

document.addEventListener('click', (e) => {
  const toggle = (e.target as HTMLElement).closest('.theme-toggle');
  if (!toggle) return;
  const light = document.documentElement.dataset.theme !== 'light';
  try {
    if (light) localStorage.setItem(THEME, 'light');
    else localStorage.removeItem(THEME);
  } catch {
    // not kept, but still switched for this page
  }
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
});

document.addEventListener('change', (e) => {
  const field = (e.target as HTMLElement).closest('form[data-auto-submit] select');
  const form = field?.closest('form');
  if (!form) return;
  // Only the choices made (no empty ?form=&series=), so each view keeps a short address.
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (typeof v === 'string' && v) params.set(k, v);
  const query = params.toString();
  navigate(`${form.getAttribute('action') || location.pathname}${query ? `?${query}` : ''}`);
});

// The router replaces <html>'s attributes with the new page's: set the theme on the incoming page first.
document.addEventListener('astro:before-swap', (e) => applyTheme((e as unknown as { newDocument: Document }).newDocument));
document.addEventListener('astro:page-load', rememberLanguage);
