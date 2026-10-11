// Title keys (lib/titles.ts): npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactTitleKey, foldLatin, titleKey } from '../src/lib/titles.ts';

test('accents an ASCII file name leaves out make no difference', () => {
  assert.equal(foldLatin('Äventyr Till Nørrland'), 'Aventyr Till Norrland');
  assert.equal(titleKey('SOLROS and the Will of the Altaïr'), titleKey('SOLROS and the Will of the Altair'));
  assert.equal(titleKey('Löwenheim'), titleKey('Lowenheim'));
  assert.equal(titleKey('La Fée Risette'), titleKey('La Fee Risette'));
  assert.equal(exactTitleKey('SOLROS -Memories of the Nørrland-'), exactTitleKey('SOLROS -Memories of the Norrland-'));
  assert.equal(titleKey('Ærø Œuvre Straße'), titleKey('AEro OEuvre Strasse'));
});

test('kana keep their marks', () => {
  assert.notEqual(titleKey('ガイデリア'), titleKey('カイデリア'));
  assert.equal(foldLatin('ポラリス'), 'ポラリス');
  assert.equal(titleKey('ＡＢＣ'), titleKey('abc'));
});

test('notes in brackets: left out for songs, kept for track entries', () => {
  assert.equal(titleKey('Äventyr Till Nørrland (Remastered ver.)'), titleKey('Aventyr Till Norrland'));
  assert.notEqual(exactTitleKey('Äventyr Till Nørrland (Remastered ver.)'), exactTitleKey('Aventyr Till Norrland'));
  assert.equal(exactTitleKey("Aquila: Will-o'-the-wisp"), exactTitleKey("Aquila- Will-o'-the-wisp"));
  assert.notEqual(exactTitleKey('Äventyr'), exactTitleKey('Äventyr -Ancient rite-'));
});
