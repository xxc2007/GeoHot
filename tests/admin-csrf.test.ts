// 后台写请求的 CSRF 门：缺头、数组头、错令牌一律 403，对令牌才放行；比较走恒定时间路径
// （timingSafeEqualString，HMAC 后 timingSafeEqual），与会话令牌、登录口令同一标准。
// 直接调用 adminHandler 包出来的处理器：假 req/reply 只实现它真正用到的那几个面。
import './setup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { adminHandler } from '../apps/api/src/routes/admin-auth.ts';
import { timingSafeEqualString } from '@aihot/backend/admin/auth';

const principal = { userId: 1, name: 'operator', csrf: 'token-abc', dev: false };
const authenticate = async () => principal;

interface Captured { status?: number; body?: Buffer; headers: Record<string, string> }
function fakeReply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { headers: {} };
  const reply = {
    header(k: string, v: string) { captured.headers[k.toLowerCase()] = v; return reply; },
    code(c: number) { captured.status = c; return reply; },
    send(b: Buffer) { captured.body = b; return reply; },
  } as unknown as FastifyReply;
  return { reply, captured };
}

function fakeReq(method: string, headers: Record<string, unknown>): FastifyRequest {
  return { method, url: '/api/admin/x', headers, requestId: 'csrf-test', log: { error: () => {} } } as unknown as FastifyRequest;
}

test('timingSafeEqualString：等值判真，不等与不等长判假，不抛异常', () => {
  assert.equal(timingSafeEqualString('token-abc', 'token-abc'), true);
  assert.equal(timingSafeEqualString('token-abc', 'token-abd'), false);
  assert.equal(timingSafeEqualString('token-abc', 'token-abc-too-long'), false);
  assert.equal(timingSafeEqualString('', ''), true);
});

test('CSRF 门：缺头、数组头、错令牌都 403，对令牌放行，GET 不需要令牌', async () => {
  const handler = adminHandler(async () => ({ ok: true }), authenticate);
  for (const headers of [
    {},
    { 'x-csrf-token': ['token-abc', 'extra'] },
    { 'x-csrf-token': 'wrong-token' },
  ]) {
    const { reply, captured } = fakeReply();
    await handler(fakeReq('POST', headers), reply);
    assert.equal(captured.status, 403, `头 ${JSON.stringify(headers)} 必须被拒`);
    assert.match(String(captured.body), /forbidden/);
  }
  const ok = fakeReply();
  const result = await handler(fakeReq('POST', { 'x-csrf-token': 'token-abc' }), ok.reply);
  assert.deepEqual(result, { ok: true });
  assert.equal(ok.captured.status, undefined, '对令牌时由路由自己决定响应码');
  const get = fakeReply();
  assert.deepEqual(await handler(fakeReq('GET', {}), get.reply), { ok: true });
});
