import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeDb } from '@aihot/backend/db';
import { createAdminControl, isAdminControlPath } from '../apps/web/admin-control.ts';
after(closeDb);

test('control reads survive an unavailable business API and immediately reject revoked identity', async () => {
  let valid = true;
  const app = await createAdminControl({ authenticate: async () => valid ? { userId: 1, name: 'operator', csrf: 'test', dev: false } : null });
  try {
    const me = await app.inject('/api/admin/me');
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().name, 'operator');
    assert.equal(me.headers['cache-control'], 'no-store');
    // Missing metrics must remain an explicit failure, without taking identity down.
    process.env.SERVER_STATUS_FILE = '/nonexistent-control-test/status.json';
    assert.equal((await app.inject('/api/admin/server')).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/magpie-proxy/api/test', payload: {} })).statusCode, 403);
    valid = false;
    for (const url of ['/api/admin/me', '/api/admin/server', '/api/admin/magpie-proxy/']) assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal(isAdminControlPath('/api/auth/logout'), false);
    assert.equal(isAdminControlPath('/api/admin/models'), false);
    assert.equal(isAdminControlPath('/api/admin/magpie-proxy/'), true);
  } finally { delete process.env.SERVER_STATUS_FILE; await app.close(); }
});

test('identity storage failure fails closed with a retryable response', async () => {
  const app = await createAdminControl({ authenticate: async () => { throw new Error('private database error'); } });
  try {
    const r = await app.inject('/api/admin/me');
    assert.equal(r.statusCode, 503);
    assert.doesNotMatch(r.body, /private database error/);
  } finally { await app.close(); }
});
