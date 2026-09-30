// Texts that reach the admin from outside this code and are shown translated: messages the processing
// program (tools/ra) writes into files.format, and suggestion rule names it uses itself. The rule names
// in tools/ra/rules/mapping.yaml are checked by scripts/i18n-check.mjs directly.

import { N_ } from './i18n';

export const FROM_RA = [
  N_('存储里的内容与 SHA-256 不符，请重新上传'),
  N_('原始包'),
];

// Texts only older entries of the 修改记录 still use (a summary, or a parameter of one, is translated when shown).
export const FROM_HISTORY = [
  N_('实体 CD'),
  N_('扫图'),
  N_('版本 {edition}：修改曲目与标签'),
];
