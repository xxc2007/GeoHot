import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isMagpieStatic, magpieBase, isLoopbackHost} from '../apps/api/src/routes/server-console.ts';

test('root-level panel scripts and styles are static', () => {
  for (const s of ['kernel.js', 'start.js', 'app.js', 'theme.css', 'compat.js']) assert.ok(isMagpieStatic(s), s);
});

test('assets/plugins/fonts js/css/fonts/images are static', () => {
  for (const s of ['assets/app.js', 'plugins/gateway/client.js', 'fonts/local.woff2', 'assets/icons.svg']) {
    assert.ok(isMagpieStatic(s), s);
  }
});

test('dynamic API, HTML and unknown paths are not static', () => {
  for (const s of ['api/gateway/trace', 'index.html', 'private/secret.json', 'api/usage/page.js']) {
    assert.equal(isMagpieStatic(s), false, s);
  }
});

test('magpie upstream defaults to loopback 3430 and rejects non-loopback/https', () => {
  const old = process.env.MAGPIE_WEB_BASE_URL;
  try {
    delete process.env.MAGPIE_WEB_BASE_URL;
    assert.equal(magpieBase().origin, 'http://127.0.0.1:3430');
    process.env.MAGPIE_WEB_BASE_URL = 'http://127.0.0.1:3426';
    assert.equal(magpieBase().port, '3426');
    process.env.MAGPIE_WEB_BASE_URL = 'http://47.97.97.62:3430';
    assert.throws(() => magpieBase(), /loopback/);
    process.env.MAGPIE_WEB_BASE_URL = 'https://localhost:3430';
    assert.throws(() => magpieBase(), /loopback/);
  } finally {
    if (old === undefined) delete process.env.MAGPIE_WEB_BASE_URL; else process.env.MAGPIE_WEB_BASE_URL = old;
  }
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && isLoopbackHost('localhost'));
  assert.equal(isLoopbackHost('10.0.0.1'), false);
});
