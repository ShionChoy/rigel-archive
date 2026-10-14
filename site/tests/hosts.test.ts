// The site's addresses (lib/hosts.ts): npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route } from '../src/lib/hosts.ts';

const hosts = { public: 'rigeltheatre.fans', admin: 'admin.rigeltheatre.fans' };
const at = (address: string) => route(new URL(address), hosts);

test('the public site is at the domain, without the admin', () => {
  assert.deepEqual(at('https://rigeltheatre.fans/ja/works/rtcd-001/?edition=e_1'), { serve: 'public', ours: true });
  assert.deepEqual(at('https://rigeltheatre.fans/'), { serve: 'public', ours: true });
  assert.deepEqual(at('https://rigeltheatre.fans/media/i/1/sig/derived/x.webp'), { serve: 'public', ours: true });
  assert.deepEqual(at('https://rigeltheatre.fans/admin'), { notFound: true });
  assert.deepEqual(at('https://rigeltheatre.fans/admin/inbox'), { notFound: true });
  assert.deepEqual(at('https://rigeltheatre.fans/administration'), { serve: 'public', ours: true });
});

test('the admin is at admin.<domain>; anything else there goes to the public site', () => {
  assert.deepEqual(at('https://admin.rigeltheatre.fans/admin/inbox?view=all'), { serve: 'admin', ours: true });
  assert.deepEqual(at('https://admin.rigeltheatre.fans/admin/api/worker/tasks'), { serve: 'admin', ours: true });
  assert.deepEqual(at('https://admin.rigeltheatre.fans/'), { redirect: 'https://admin.rigeltheatre.fans/admin/', status: 302 });
  assert.deepEqual(at('https://admin.rigeltheatre.fans/zh/works/rtcd-001/?edition=e_1'), { redirect: 'https://rigeltheatre.fans/zh/works/rtcd-001/?edition=e_1', status: 301 });
});

test('www and plain HTTP are sent on to the HTTPS address', () => {
  assert.deepEqual(at('https://www.rigeltheatre.fans/en/about/'), { redirect: 'https://rigeltheatre.fans/en/about/', status: 301 });
  assert.deepEqual(at('http://www.rigeltheatre.fans/admin/'), { redirect: 'https://rigeltheatre.fans/admin/', status: 301 });
  assert.deepEqual(at('http://rigeltheatre.fans/zh/?q=1'), { redirect: 'https://rigeltheatre.fans/zh/?q=1', status: 301 });
  assert.deepEqual(at('http://admin.rigeltheatre.fans/admin/'), { redirect: 'https://admin.rigeltheatre.fans/admin/', status: 301 });
  assert.deepEqual(at('https://RigelTheatre.Fans/zh/'), { serve: 'public', ours: true });
});

test('other hosts serve everything, as before the domain', () => {
  assert.deepEqual(at('http://localhost:4321/admin/'), { serve: 'any', ours: false });
  assert.deepEqual(at('http://site.internal/admin/api/worker/tasks'), { serve: 'any', ours: false });
  assert.deepEqual(at('https://rigel-archive.shionchoy.workers.dev/zh/'), { serve: 'any', ours: false });
  assert.deepEqual(at('https://evil.rigeltheatre.fans/admin/'), { serve: 'any', ours: false });
  assert.deepEqual(route(new URL('https://rigeltheatre.fans/admin/'), { public: '', admin: '' }), { serve: 'any', ours: false });
});
