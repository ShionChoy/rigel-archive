// 带标签下载的文件名: one template for the whole team (like Picard's file naming script), filled from the
// tags the download is written with. {name} is a tag by its Picard name (first value; several joined with
// «, »); {tracknumber} is two digits, {discnumber} is there only on editions with more than one disc.
// [ … ] is kept only when every field in it has a value: «[{discnumber}-]{tracknumber} {title}» gives
// «08 Title» on one disc and «2-08 Title» on two. Originals are never renamed by it: they download under
// the file's own name (or the one it was renamed to). Pure functions: the page scripts use them too.

import { N_ } from './i18n';

export type NameTags = Record<string, string[]>;

export const DEFAULT_NAMING = '[{discnumber}-]{tracknumber} {title}';

export const NAMING_PRESETS = [
  DEFAULT_NAMING,
  '[{discnumber}-]{tracknumber}. [{artist} - ]{title}',
  '[{artist} - ]{title}',
  '{title}',
];

export interface NameParts {
  tags: NameTags; // what the download is written with (the row's over the file's own)
  position: number | null;
  disc: number | null;
  discs: number; // how many discs the edition has
}

/** A name that works on Windows, macOS and in zips: no \ / : * ? " < > | or control characters. */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
}

function field(name: string, p: NameParts): string {
  const key = name.trim().toLowerCase();
  if (key === 'tracknumber') return p.position ? String(p.position).padStart(2, '0') : '';
  if (key === 'discnumber') return p.discs > 1 && p.disc ? String(p.disc) : '';
  return (p.tags[key] ?? []).map((v) => v.trim()).filter(Boolean).join(', ');
}

const FIELDS = /\{([^{}]+)\}/g;

/** The name a template gives (without the extension); '' when nothing is left. */
export function renderName(template: string, p: NameParts): string {
  const fill = (text: string) => text.replace(FIELDS, (_, k: string) => field(k, p));
  const optional = template.replace(/\[([^[\]]*)\]/g, (_, inner: string) =>
    [...inner.matchAll(FIELDS)].every((m) => field(m[1], p)) ? fill(inner) : '');
  // Windows refuses names ending in a dot or a space.
  return safeName(fill(optional)).replace(/[. ]+$/, '');
}

/** Why a template cannot be used ('' = it can); the text is translated by the caller. */
export function namingProblem(template: string): string {
  const s = template.trim();
  if (!s) return N_('模板不能为空');
  if (s.length > 200) return N_('模板太长（最多 200 个字符）');
  if (!/\{[^{}]+\}/.test(s)) return N_('模板里至少要有一个字段，比如 {title}');
  if (/[\\/:*?"<>|]/.test(s.replace(FIELDS, ''))) return N_('文件名不能包含 \\ / : * ? " < > |');
  let depth = 0;
  for (const c of s) {
    if (c === '[') depth += 1;
    if (c === ']') depth -= 1;
    if (depth < 0 || depth > 1) return N_('方括号 [ ] 要成对，且不能嵌套');
  }
  return depth ? N_('方括号 [ ] 要成对，且不能嵌套') : '';
}

/**
 * The tags a row's download ends up with for naming: the file's own, then the row's over them ([] removes
 * one), with the track list's title when neither has one.
 */
export function namingTags(original: NameTags, overrides: NameTags, fallbackTitle: string): NameTags {
  const out: NameTags = { ...original };
  for (const [k, v] of Object.entries(overrides)) {
    if (v.length) out[k] = v;
    else delete out[k];
  }
  if (!out.title?.some((v) => v.trim()) && fallbackTitle) out.title = [fallbackTitle];
  return out;
}
