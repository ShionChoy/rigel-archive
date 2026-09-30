// Tag values as the 版本页 (scripts/edition.ts) and the 整理台's tag dialog (scripts/tag-dialog.ts) edit them:
// several values of one tag are typed as «a; b». Numbers (track, disc) come from the track list's order.
export { NUMBER_TAGS as NUMBERS } from '../lib/tagging/names';
export { sameValues as same } from '../lib/tagging/model';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const join = (v: string[] | undefined) => (v ?? []).join('; ');
export const parse = (text: string) => [...new Set(text.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean))];
