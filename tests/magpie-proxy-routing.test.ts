import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isMagpieStatic} from '../apps/api/src/routes/server-console.ts';

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
