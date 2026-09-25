// Texts that reach the admin from outside this code and are shown translated: messages the processing
// program (tools/ra) writes into files.format, and suggestion rule names it uses itself. The rule names
// in tools/ra/rules/mapping.yaml are checked by scripts/i18n-check.mjs directly.

import { N_ } from './i18n';

export const FROM_RA = [
  N_('存储里的内容与 SHA-256 不符，请重新上传'),
  N_('原始包'),
];
