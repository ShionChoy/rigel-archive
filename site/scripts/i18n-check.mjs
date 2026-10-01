// Lists the texts that have no Japanese yet, and the public site's texts that have no English yet
// (npm run check:i18n; part of npm run deploy).
//
// Texts are found where the code marks them: t('…') (or tr('…'), a translator passed in), translateHtml(lang, '…'),
// N_('…'), new UserError('…') / ConfirmError('…'), summary('…'), plus the rule names in tools/ra/rules/mapping.yaml. Each
// translation must keep the {placeholders} of its key.
// The public site's texts are the ones in its files (PUBLIC) and in the shared labels it shows (PUBLIC_LABELS).
// `--missing` / `--missing-en` print the missing keys as JSON (for adding them to src/lib/i18n-ja.ts / i18n-en.ts).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EN } from '../src/lib/i18n-en.ts';
import { JA } from '../src/lib/i18n-ja.ts';

const PUBLIC = [
  'pages/[lang]/', 'pages/404.astro', 'pages/api/', 'pages/media/', 'layouts/Site.astro', 'components/site/',
  'components/ReleaseView.astro', 'components/Player.astro', 'lib/public/', 'lib/release-view.ts', 'scripts/site.ts', 'scripts/player.ts',
];
/** Constants of shared labels that public pages show by lookup (t(RELATION_TEXT[relation])). */
const PUBLIC_LABELS = [['lib/editions.ts', 'RELATION_TEXT']];

const ROOT = new URL('../src/', import.meta.url).pathname;
const CALL = /(?:\b(?:t|tr|N_|summary|summaryOf|new UserError|new ConfirmError)\(|\btranslateHtml\(\s*\w+\s*,)\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`)/g;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|astro)$/.test(name) && !name.startsWith('i18n-ja') && !name.startsWith('i18n-en')) yield path;
  }
}

const unquote = (s) => s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
const found = new Map(); // key -> first place
const shown = new Map(); // key -> first place on the public site
const collect = (text, where, into) => {
  for (const m of text.matchAll(CALL)) {
    const key = unquote(m[1]);
    if (!/[　-鿿＀-￯]/.test(key)) continue; // nothing to translate (codes, URLs)
    if (!into.has(key)) into.set(key, `${where}:${text.slice(0, m.index).split('\n').length}`);
  }
};
for (const path of files(ROOT)) {
  const text = readFileSync(path, 'utf8');
  const rel = relative(ROOT, path);
  collect(text, rel, found);
  if (PUBLIC.some((p) => rel.startsWith(p))) collect(text, rel, shown);
}
for (const [file, name] of PUBLIC_LABELS) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${file}: ${name} not found`);
  collect(text.slice(start, text.indexOf('};', start)), file, shown);
}

// Suggestion rule names come from the import rules and are shown translated too.
const rules = readFileSync(new URL('../../tools/ra/rules/mapping.yaml', import.meta.url), 'utf8');
for (const m of rules.matchAll(/^- name: (.+)$/gm)) {
  const key = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  if (/[\u3000-\u9fff\uff00-\uffef]/.test(key) && !found.has(key)) found.set(key, 'tools/ra/rules/mapping.yaml');
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const missing = [...found.keys()].filter((k) => !(k in JA));
const missingEn = [...shown.keys()].filter((k) => !(k in EN));
const broken = [...Object.entries(JA), ...Object.entries(EN)].filter(([k, v]) => placeholders(k) !== placeholders(v));
const unused = Object.keys(JA).filter((k) => !found.has(k));
const unusedEn = Object.keys(EN).filter((k) => !shown.has(k));

if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(missing, null, 1));
  process.exit(0);
}
if (process.argv.includes('--missing-en')) {
  console.log(JSON.stringify(missingEn, null, 1));
  process.exit(0);
}
for (const k of missing) console.log(`missing  ${found.get(k)}  ${k}`);
for (const k of missingEn) console.log(`missing English  ${shown.get(k)}  ${k}`);
for (const [k, v] of broken) console.log(`placeholders differ  ${k}  →  ${v}`);
for (const k of unused) console.log(`unused   ${k}`);
for (const k of unusedEn) console.log(`unused English   ${k}`);
console.log(`${found.size} texts (${shown.size} on the public site), ${missing.length} without Japanese, ${missingEn.length} without English, `
  + `${broken.length} with wrong placeholders, ${unused.length + unusedEn.length} unused`);
process.exit(missing.length || missingEn.length || broken.length ? 1 : 0);
