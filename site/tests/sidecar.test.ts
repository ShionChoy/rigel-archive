// Lyrics files next to audio files (lib/sidecar.ts) and how they are read (lib/lyrics.ts decodeText): npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeText, parseLyrics } from '../src/lib/lyrics.ts';
import { isLyricsOf, lyricsFileFor } from '../src/lib/sidecar.ts';

const file = (name: string, folder = 'fd1', edition = 'e1', download_name: string | null = null) => ({ name, ext: name.split('.').pop()!, folder_id: folder, edition_id: edition, download_name });

test('the .lrc named like the audio file, in its folder', () => {
  const audio = file('01. Lyla and the Starry Fairy.wav');
  const files = [file('01. Lyla and the Starry Fairy.cue'), file('01. lyla and the starry fairy.LRC'), file('02. Other.lrc')];
  assert.equal(lyricsFileFor(audio, files)?.name, '01. lyla and the starry fairy.LRC');
  assert.equal(lyricsFileFor(file('03. None.flac'), files), undefined);
});

test('not from another folder or edition', () => {
  const audio = file('01. Song.flac');
  assert.equal(lyricsFileFor(audio, [file('01. Song.lrc', 'fd2')]), undefined);
  assert.equal(lyricsFileFor(audio, [file('01. Song.lrc', 'fd1', 'e2')]), undefined);
});

test('by the name it is downloaded as, and composed/decomposed kana alike', () => {
  const audio = file('track01.wav', 'fd1', 'e1', '01. ガイデリア.wav');
  assert.ok(lyricsFileFor(audio, [file('01. ガイデリア.lrc'.normalize('NFD'))]));
});

test('a matched .lrc goes with its track; others stay attachments', () => {
  const audios = [file('01. Song.flac'), file('01. Song.wav')];
  assert.equal(isLyricsOf(file('01. Song.lrc'), audios), true);
  assert.equal(isLyricsOf(file('notes.lrc'), audios), false);
  assert.equal(isLyricsOf(file('01. Song.txt'), audios), false);
});

const lrc = '[00:01.00]星の歌\n[00:05.00]歌词';
const bytes = (label: 'utf-16le' | 'utf-16be', text: string) => {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out[i * 2 + (label === 'utf-16le' ? 0 : 1)] = c & 0xff;
    out[i * 2 + (label === 'utf-16le' ? 1 : 0)] = c >> 8;
  }
  return out;
};

test('UTF-8 with and without a byte order mark', () => {
  const plain = new TextEncoder().encode(lrc);
  assert.equal(decodeText(plain), lrc);
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...plain])), lrc);
});

test('UTF-16 with a mark, and without one', () => {
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, ...bytes('utf-16le', lrc)])), lrc);
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, ...bytes('utf-16be', lrc)])), lrc);
  assert.equal(decodeText(bytes('utf-16le', lrc)), lrc);
});

test('Shift_JIS and GBK', () => {
  // 「[00:01.00]あいの歌」 in Shift_JIS; 「[00:01.00]歌词」 in GBK
  const sjis = new Uint8Array([...new TextEncoder().encode('[00:01.00]'), 0x82, 0xa0, 0x82, 0xa2, 0x82, 0xcc, 0x89, 0xcc]);
  const gbk = new Uint8Array([...new TextEncoder().encode('[00:01.00]'), 0xb8, 0xe8, 0xb4, 0xca]);
  assert.equal(decodeText(sjis), '[00:01.00]あいの歌');
  assert.equal(decodeText(gbk), '[00:01.00]歌词');
  assert.deepEqual(parseLyrics(decodeText(gbk))?.lines, [{ t: 1, text: '歌词' }]);
});
