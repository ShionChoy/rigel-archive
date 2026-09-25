// The admin's language in browser scripts: the page's <html lang> (set by layouts/Admin.astro).
import { translate, type Params } from '../lib/i18n';

const lang = () => (document.documentElement.lang === 'ja' ? 'ja' : 'zh');

export function t(text: string, params?: Params): string {
  return translate(lang(), text, params);
}
