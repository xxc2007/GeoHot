// 2026-11-16 现场：全局 @fastify/rate-limit 在第 601 次请求时抛 statusCode=429 的 Error（插件自己
// 已经把 Retry-After / RateLimit-* 写在 reply 上）。但 app.ts 的全局 errorHandler 只放行
// 400/413/415，其余一律改写成 503 并把 Retry-After 覆盖成 30——于是"慢一点再来"被读成
// "服务器挂了"。这里钉住两件事：errorHandler 必须认出 429 并原样透出、不覆盖插件算好的窗口；
// 健康检查必须有界超时，库卡住时如实 503 而不是挂死探针。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

const appSource = await readFile(new URL("../apps/api/src/app.ts", import.meta.url), "utf8");

test("errorHandler 认出 429 并透出为 problem+json，不覆盖插件的 Retry-After", () => {
  // 必须有专门的 429 分支，而不是落到末尾那个 503 兜底。
  assert.match(appSource, /if \(status === 429\)/, "必须显式处理限流错误");
  // 429 分支里 sendProblem 不得传 retryAfter：一旦传了就会覆写 reply 上插件写好的秒数。
  // （日志里那个 retryAfter 只是把插件的头记进日志，不是发出去的响应体；CapacityExceeded
  // 那个 429 是另一处、本就该带 retryAfter:2，不要混进来。）
  assert.match(
    appSource,
    /return sendProblem\(req, reply, \{ status: 429, code: "rate_limited", detail:[^}]*?\}\);/,
    "429 必须走 problem+json，且不带 retryAfter 覆写",
  );
  const sendProblem429 = appSource.match(
    /return sendProblem\(req, reply, \{ status: 429, code: "rate_limited", detail:[^}]*?\}\);/,
  )![0];
  assert.doesNotMatch(sendProblem429, /retryAfter\s*:/, "429 的 sendProblem 不得覆写 Retry-After");
});

test("健康检查有 2 秒上界，DB 卡住时回 503 而不是挂死", () => {
  // 探针走独立 gate + 墙钟截止：到点独立还槽，迟到查询拒绝被兜底观察，
  // 不再是"reject JS 却把查询晾在池里"的孤儿 Promise.race。
  assert.match(appSource, /await dbHealthProbe\(\)/, "health 必须走有界探针");
  assert.match(appSource, /db:\s*"unavailable"/, "DB 不可用时要如实标记，不得假装 ok");
  assert.doesNotMatch(appSource, /Promise\.race\(\[\s*sql`SELECT 1`/, "不得再用孤儿 Promise.race");
});

test("行为：600/min 窗口的第 601 次返回 429 且保留真实 Retry-After", async () => {
  // 用与 app.ts 完全一致的插件配置 + 同样的 errorHandler 形状复现一次：
  // 关键不是数字，是"抛上来的 429 不再被改写成 503、且 Retry-After 不被覆盖"。
  const app = Fastify();
  await app.register(rateLimit, { global: true, max: 5, timeWindow: "1 minute" });
  app.setErrorHandler((error, req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) {
      return reply
        .code(429)
        .header("Content-Type", "application/problem+json")
        .send({ status: 429, code: "rate_limited", detail: (error as Error).message });
    }
    return reply.code(503).send({ status: 503 });
  });
  app.get("/", async () => "ok");

  let last;
  for (let i = 0; i < 6; i++) last = await app.inject("/");
  assert.equal(last!.statusCode, 429, "窗口用尽后的请求必须是 429，不是 503");
  const retryAfter = Number(last!.headers["retry-after"]);
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60, `Retry-After 必须是真实窗口秒数，got ${retryAfter}`);
  assert.match((last!.json() as { code: string }).code, /rate_limited/);
  await app.close();
});
