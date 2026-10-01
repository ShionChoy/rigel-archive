// The access rules (lib/access.ts, 设计文档「文件权限方案 · 生效规则」): npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessOf, clipFromInput, clipSpan, parseClip, OPEN_EDITION, type EditionAccessRow } from '../src/lib/access.ts';

const ed = (p: Partial<EditionAccessRow> = {}): EditionAccessRow => ({ ...OPEN_EDITION, ...p });
const none = { pub_visible: null, pub_play: null, pub_clip: null, pub_quality: null, pub_download: null };

test('defaults open everything for own and licensed files', () => {
  for (const rights of ['own', 'licensed']) {
    const a = accessOf({ rights, kind: 'audio', ...none }, ed());
    assert.equal(a.visible, true); assert.equal(a.play, 'full'); assert.equal(a.quality, 'original'); assert.equal(a.download, true);
  }
});
test('rights cap: third party listed only, unknown hidden, even when settings open more', () => {
  const t = accessOf({ rights: 'third_party', kind: 'audio', ...none, pub_play: 'full', pub_download: 1 }, ed());
  assert.deepEqual([t.visible, t.play, t.download, t.ceiling], [true, 'none', false, 'listed']);
  const t2 = accessOf({ rights: 'third_party', kind: 'image', ...none, pub_visible: 0 }, ed());
  assert.equal(t2.visible, false);
  const u = accessOf({ rights: 'unknown', kind: 'audio', ...none, pub_visible: 1 }, ed());
  assert.deepEqual([u.visible, u.play, u.download], [false, 'none', false]);
});
test('file settings override the edition, each on its own', () => {
  const e = ed({ pub_quality: 'lossy', pub_download: 0 });
  const a = accessOf({ rights: 'own', kind: 'image', ...none, pub_download: 1 }, e);
  assert.deepEqual([a.download, a.quality, a.own.download, a.own.quality], [true, 'lossy', true, false]);
  const b = accessOf({ rights: 'own', kind: 'audio', ...none, pub_quality: 'original' }, e);
  assert.deepEqual([b.download, b.quality], [false, 'original']);
});
test('hidden files neither play nor download; clip is for audio only', () => {
  const h = accessOf({ rights: 'own', kind: 'audio', ...none, pub_visible: 0 }, ed());
  assert.deepEqual([h.visible, h.play, h.download], [false, 'none', false]);
  const img = accessOf({ rights: 'own', kind: 'image', ...none }, ed({ pub_play: 'clip' }));
  assert.equal(img.play, 'full');
  const aud = accessOf({ rights: 'own', kind: 'audio', ...none }, ed({ pub_play: 'clip', pub_clip: '30%+45' }));
  assert.deepEqual([aud.play, aud.clip], ['clip', { start: 30, percent: true, length: 45 }]);
});
test('clip input and spans', () => {
  assert.equal(clipFromInput('1:30', '60'), '90+60');
  assert.equal(clipFromInput('30%', '45'), '30%+45');
  assert.equal(clipFromInput('', '60'), '0+60');
  assert.equal(clipFromInput('0:75', '60'), null);
  assert.equal(clipFromInput('120%', '60'), null);
  assert.equal(clipFromInput('10', '5'), null);
  assert.equal(clipFromInput('1:02:03', '30'), '3723+30');
  assert.equal(parseClip('30%+601'), null);
  assert.deepEqual(clipSpan(parseClip('30%+60')!, 200), { from: 60, to: 120 });
  assert.deepEqual(clipSpan(parseClip('190+60')!, 200), { from: 140, to: 200 });
  assert.deepEqual(clipSpan(parseClip('0+60')!, 40), { from: 0, to: 40 });
  assert.deepEqual(clipSpan(parseClip('50%+60')!, null), { from: 0, to: 60 });
});
