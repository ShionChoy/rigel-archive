// Comparing titles: the same title written another way (case, width, punctuation, the accents an ASCII file
// name leaves out) gives the same key. Pure functions, used by the server and the pages' scripts alike.

/** Latin letters with no decomposition (ø is not o + a mark), written as plain letters. */
const PLAIN: Record<string, string> = {
  ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ß: 'ss', ẞ: 'SS', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D',
  ł: 'l', Ł: 'L', þ: 'th', Þ: 'Th', ı: 'i', ħ: 'h', Ħ: 'H',
};

/**
 * Latin letters without their accents («Äventyr Till Nørrland» → «Aventyr Till Norrland»). Only marks on
 * Latin letters go: kana keep their dakuten (が is not か).
 */
export function foldLatin(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFKC')
    .replace(/[øØæÆœŒßẞđĐðÐłŁþÞıħĦ]/g, (c) => PLAIN[c]);
}

const BRACKETED = /[(（[【<〈『「][^)）\]】>〉』」]*[)）\]】>〉』」]/g;
const SEPARATORS = /[\s\-‐‑–—~〜～_.,:;!?'"’“”・･·/\\]+/g;

/**
 * The same piece of music: case, width, punctuation, accents and notes in brackets («(Remastered ver.)»,
 * «[XFD]») left out. For songs, and for finding a release's track by title.
 */
export function titleKey(title: string): string {
  return foldLatin(title).toLowerCase().replace(BRACKETED, '').replace(SEPARATORS, '');
}

/**
 * The same track title: like titleKey, but the words in brackets count («Äventyr Till Nørrland» and
 * «… (Remastered ver.)» differ). For telling whether two track entries are one.
 */
export function exactTitleKey(title: string): string {
  return foldLatin(title).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
