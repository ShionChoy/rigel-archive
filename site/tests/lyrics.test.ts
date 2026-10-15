// Lyrics (lib/lyrics.ts): npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineAt, parseLyrics } from '../src/lib/lyrics.ts';

test('no lyrics', () => {
  assert.equal(parseLyrics(null), null);
  assert.equal(parseLyrics(''), null);
  assert.equal(parseLyrics('\n \r\n\t'), null);
});

test('plain lyrics: old iTunes line ends, verses kept apart by one blank line', () => {
  const l = parseLyrics('\r\nかすみゆく空　太陽\r雲はとけて　夢現\r\r\r冷たい　水の\r\r')!;
  assert.equal(l.synced, false);
  assert.deepEqual(l.lines.map((x) => x.text), ['かすみゆく空　太陽', '雲はとけて　夢現', '', '冷たい　水の']);
  assert.ok(l.lines.every((x) => x.t === null));
});

test('a stray time in plain lyrics does not make them synced', () => {
  const l = parseLyrics('[1:23] ここから\n二番\n三番\n四番')!;
  assert.equal(l.synced, false);
  assert.equal(l.lines[0].text, '[1:23] ここから');
});

test('LRC: header tags dropped, times sorted, repeated lines, word times', () => {
  const l = parseLyrics('[ti:Song]\n[ar:Someone]\n[00:12.50]first\n[00:20.00][01:10.00]chorus\n[00:30.1]<00:30.10>wo<00:30.50>rds\n[00:40]\n[00:41.000]last')!;
  assert.equal(l.synced, true);
  assert.deepEqual(l.lines.map((x) => [x.t, x.text]), [[12.5, 'first'], [20, 'chorus'], [30.1, 'words'], [40, ''], [41, 'last'], [70, 'chorus']]);
});

test('LRC: offset shows lines earlier, never before 0', () => {
  const l = parseLyrics('[offset:+500]\n[00:00.20]a\n[00:10.00]b')!;
  assert.deepEqual(l.lines.map((x) => x.t), [0, 9.5]);
});

test('LRC: lines sharing a time are a translation; leading pauses dropped', () => {
  const l = parseLyrics('[00:01.00]\n[00:05.00]星の歌\n[00:05.00]Song of the stars\n[00:05.00]星之歌\n[00:09.00]次')!;
  assert.deepEqual(l.lines, [{ t: 5, text: '星の歌', tr: ['Song of the stars', '星之歌'] }, { t: 9, text: '次' }]);
});

test('the line playing at a time', () => {
  const { lines } = parseLyrics('[00:05]a\n[00:10]b\n[00:15]c')!;
  assert.equal(lineAt(lines, 0), -1);
  assert.equal(lineAt(lines, 5), 0);
  assert.equal(lineAt(lines, 12.3), 1);
  assert.equal(lineAt(lines, 99), 2);
});
