// Stray query parameters on public pages (lib/public/query.ts): npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutStrayParams } from '../src/lib/public/query.ts';

const at = (address: string) => withoutStrayParams(new URL(address, 'https://rigeltheatre.fans'));

test('addresses the site links to stay as they are', () => {
  for (const address of [
    '/zh/', '/ja/works/', '/en/about/', '/zh/songs/s_1/',
    '/zh/works/?view=timeline', '/zh/works/?era=rigel-theatre&form=album', '/zh/works/?series=SOLROS%2FLengsel&year=2014',
    '/ja/works/?series=%E3%81%9D%E3%81%AE%E4%BB%96', '/zh/works/?form=dl_card&era=dezaemon&view=timeline',
    '/zh/works/rtcd-001/?edition=e_81bd679b41819fee', '/zh/works/rtcd-001/?view=compare',
    '/zh/works/rtcd-001/?edition=e_81bd679b41819fee&view=compare', '/zh/works/rtcd-001/?view=compare&edition=e_1',
    '/zh/works/?series=A+B', '/zh/works/?series=A%20B',
  ]) assert.equal(at(address), null, address);
});

test('parameters a page does not read are dropped', () => {
  assert.equal(at('/zh/?x=123'), '/zh/');
  assert.equal(at('/zh/about/?utm_source=t&fbclid=abc'), '/zh/about/');
  assert.equal(at('/zh/works/?era=dezaemon&x=1'), '/zh/works/?era=dezaemon');
  assert.equal(at('/zh/works/rtcd-001/?edition=e_1&year=2014'), '/zh/works/rtcd-001/?edition=e_1');
  assert.equal(at('/zh/songs/s_1/?edition=e_1'), '/zh/songs/s_1/');
  assert.equal(at('/zh/works/?constructor=1&__proto__=2'), '/zh/works/');
});

test('values of the wrong shape, repeats and empty pieces are dropped', () => {
  assert.equal(at('/zh/works/?view=grid'), '/zh/works/');
  assert.equal(at('/zh/works/?year=20140'), '/zh/works/');
  assert.equal(at('/zh/works/?year=abcd&era=dezaemon'), '/zh/works/?era=dezaemon');
  assert.equal(at('/zh/works/rtcd-001/?view=timeline'), '/zh/works/rtcd-001/');
  assert.equal(at('/zh/works/?era='), '/zh/works/');
  assert.equal(at(`/zh/works/?series=${'x'.repeat(101)}`), '/zh/works/');
  assert.equal(at('/zh/works/?era=a&era=b'), '/zh/works/?era=a');
  assert.equal(at('/zh/works/?&'), '/zh/works/');
  assert.equal(at('/zh/works/?era=a&'), '/zh/works/?era=a');
  assert.equal(at('/zh/works/rtcd-001/?=1'), '/zh/works/rtcd-001/');
});

test('the address sent to is never sent on again', () => {
  for (const address of ['/zh/works/?era=a&x=1&era=b&', '/zh/works/?series=%E2%98%85+x&utm=1', '/zh/works/r/?edition=e%5F1&y=2', '/zh/works/?series=a%26b&z']) {
    const target = at(address);
    assert.ok(target, address);
    assert.equal(at(target), null, `${address} → ${target}`);
  }
});
