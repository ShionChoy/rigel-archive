// Lists the admin texts that have no Japanese yet (npm run check:i18n; part of npm run deploy).
//
// Texts are found where the code marks them: t('…'), translateHtml(lang, '…'), N_('…'),
// new UserError('…'), summary('…'), plus the rule names in tools/ra/rules/mapping.yaml. Each Japanese
// text must keep the {placeholders} of its key.
// `--missing` prints the missing keys as JSON (for adding them to src/lib/i18n-ja.ts).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { JA } from '../src/lib/i18n-ja.ts';

const ROOT = new URL('../src/', import.meta.url).pathname;
const CALL = /(?:\b(?:t|N_|summary|summaryOf|new UserError)\(|\btranslateHtml\(\s*\w+\s*,)\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|astro)$/.test(name) && !name.startsWith('i18n-ja')) yield path;
  }
}

const unquote = (s) => s.slice(1, -1).replace(/\\(.)/g, '$1');
const found = new Map(); // key -> first place
for (const path of files(ROOT)) {
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(CALL)) {
    const key = unquote(m[1]);
    if (!/[　-鿿＀-￯]/.test(key)) continue; // nothing to translate (codes, URLs)
    if (!found.has(key)) found.set(key, `${relative(ROOT, path)}:${text.slice(0, m.index).split('\n').length}`);
  }
}

// Suggestion rule names come from the import rules and are shown translated too.
const rules = readFileSync(new URL('../../tools/ra/rules/mapping.yaml', import.meta.url), 'utf8');
for (const m of rules.matchAll(/^- name: (.+)$/gm)) {
  const key = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  if (/[\u3000-\u9fff\uff00-\uffef]/.test(key) && !found.has(key)) found.set(key, 'tools/ra/rules/mapping.yaml');
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const missing = [...found.keys()].filter((k) => !(k in JA));
const broken = Object.entries(JA).filter(([k, v]) => placeholders(k) !== placeholders(v));
const unused = Object.keys(JA).filter((k) => !found.has(k));

if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(missing, null, 1));
  process.exit(0);
}
for (const k of missing) console.log(`missing  ${found.get(k)}  ${k}`);
for (const [k, v] of broken) console.log(`placeholders differ  ${k}  →  ${v}`);
for (const k of unused) console.log(`unused   ${k}`);
console.log(`${found.size} texts, ${missing.length} without Japanese, ${broken.length} with wrong placeholders, ${unused.length} unused`);
process.exit(missing.length || broken.length ? 1 : 0);
