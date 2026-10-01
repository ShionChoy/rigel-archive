// Interface languages. Texts are written in Chinese in the code and looked up in the Japanese table
// (i18n-ja.ts) or, on the public site, the English one (i18n-en.ts); a text missing there is shown in
// Chinese. `npm run check:i18n` lists the texts used in the code that have no Japanese yet, and the texts
// of the public site that have no English.
//
//   t('已删除 {name}', { name })   → 「{name} を削除しました」 for a Japanese admin
//
// The admin is in Chinese or Japanese (LANGS); the public site also in English (SITE_LANGS).
// Catalog data (titles, notes, file names) is never translated here; it has its own translations table.

import { EN } from './i18n-en';
import { JA } from './i18n-ja';

export const LANGS = ['zh', 'ja'] as const;
export type Lang = (typeof LANGS)[number];
export const SITE_LANGS = ['zh', 'ja', 'en'] as const;
export type SiteLang = (typeof SITE_LANGS)[number];
export const LANG_NAMES: Record<SiteLang, string> = { zh: '中文', ja: '日本語', en: 'English' };
export const HTML_LANG: Record<SiteLang, string> = { zh: 'zh-CN', ja: 'ja', en: 'en' };

export type Params = Record<string, string | number | null | undefined>;
/** A translator; `lang` is the language it translates into (catalog data with its own per-language
 * values, such as the names of edition types, reads it). */
export type T = ((text: string, params?: Params) => string) & { lang?: SiteLang };

/** Marks a text for translation where it is defined (labels in constants); translate it where shown. */
export const N_ = <S extends string>(text: S): S => text;

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

export function isSiteLang(value: unknown): value is SiteLang {
  return typeof value === 'string' && (SITE_LANGS as readonly string[]).includes(value);
}

/**
 * Put the parameters in. A translation may choose a word by a number: «{n} {n:track|tracks}» (the English
 * table uses it; Chinese and Japanese need no plurals).
 */
function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text
    .replace(/\{(\w+):([^|{}]*)\|([^{}]*)\}/g, (whole, key: string, one: string, other: string) => (key in params ? (Number(params[key]) === 1 ? one : other) : whole))
    .replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key] ?? '') : whole));
}

export function translate(lang: SiteLang, text: string, params?: Params): string {
  return fill(lang === 'ja' ? (JA[text] ?? text) : lang === 'en' ? (EN[text] ?? text) : text, params);
}

export function translator(lang: SiteLang): T {
  const t: T = (text, params) => translate(lang, text, params);
  t.lang = lang;
  return t;
}

/** Japanese first in Accept-Language → ja; anything else → zh. */
export function langFromHeader(header: string | null): Lang {
  const first = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('ja') ? 'ja' : 'zh';
}

/** The public site's language for a visitor: the first of Accept-Language that the site has, else English. */
export function siteLangFromHeader(header: string | null): SiteLang {
  for (const part of (header ?? '').split(',')) {
    const code = part.split(';')[0].trim().toLowerCase();
    if (code.startsWith('ja')) return 'ja';
    if (code.startsWith('zh')) return 'zh';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * For texts that carry markup (<code>, <b>, links) in both languages: the text itself is ours and
 * trusted, the parameters are escaped. Use with set:html.
 */
export function translateHtml(lang: SiteLang, text: string, params?: Params): string {
  const safe = params && Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeHtml(String(v ?? ''))]));
  return translate(lang, text, safe);
}

/** An error whose message is a text to translate, with parameters. */
export class UserError extends Error {
  constructor(
    readonly text: string,
    readonly params?: Params,
  ) {
    super(fill(text, params));
  }
}

/** Parameters that are themselves labels (「文件」, a slot's name) are translated too; names and ids pass. */
function translateParams(params: Params | undefined, t: T): Params | undefined {
  return params && Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? t(v) : v]));
}

/** What to show for a caught error, in the admin's language. */
export function errorText(e: unknown, t: T): string {
  if (e instanceof UserError) return t(e.text, translateParams(e.params, t));
  if (e instanceof Error) return t(e.message);
  return t(String(e));
}

/**
 * Revision summaries are stored as {"k": text, "p": params} so the history reads in each admin's
 * language; an undo wraps the summary it undoes ({"k": "撤销：{what}", "u": …}). Older plain-text
 * summaries are shown as they are (translated when they match a text).
 */
export function summary(text: string, params?: Params): string {
  return JSON.stringify(params ? { k: text, p: params } : { k: text });
}

export function undoSummary(undone: string): string {
  return JSON.stringify({ k: '撤销：{what}', u: undone });
}

export function summaryText(raw: string, t: T): string {
  if (raw.startsWith('{')) {
    try {
      const s = JSON.parse(raw) as { k?: unknown; p?: Params; u?: string };
      if (typeof s.k === 'string') {
        const params = { ...translateParams(s.p, t), ...(typeof s.u === 'string' ? { what: summaryText(s.u, t) } : {}) };
        return t(s.k, params);
      }
    } catch {
      // plain text that happens to start with a brace
    }
  }
  const undo = /^撤销：(.*)$/s.exec(raw);
  return undo ? t('撤销：{what}', { what: summaryText(undo[1], t) }) : t(raw);
}
