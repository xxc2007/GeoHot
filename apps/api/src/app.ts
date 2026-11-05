import { FEATURES } from "@aihot/industry/features";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OAUTH_PROBE_PATHS, resolveRedirect } from "@aihot/contracts/http-policy";
import { sql } from "@aihot/backend/db";
import { CapacityExceeded } from "@aihot/backend/lib/capacity";
import { registerSite } from "./routes/site.ts";
import { registerLeaderboard } from "./routes/leaderboard.ts";
import { registerOg } from "./routes/og.ts";
import { registerAdminAuth } from "./routes/admin-auth.ts";
import { registerAdmin } from "./routes/admin.ts";
import { registerServerConsole } from "./routes/server-console.ts";
import { registerIngest } from "./routes/ingest.ts";
import { registerV1, registerV1Fallbacks } from "./routes/v1.ts";
import { registerMedia } from "./routes/media.ts";
import { registerFeeds } from "./routes/feeds.ts";
import { registerStatic } from "./routes/static.ts";
import { registerMcp } from "./routes/mcp.ts";
import { sendProblem } from "./http/respond.ts";
import rateLimit from "@fastify/rate-limit";

// 版本指纹的读法：环境变量优先（临时覆盖/CI），否则读部署时落下的 .release。
// 为什么不是纯环境变量：`AIHOT_RELEASE` 是机器级的静态值，部署不会改它，于是线上会一直
// 自称旧提交（2026-11-04 实测 /api/health 报 4bf1f89，实际跑的是 70d2ac3）。
function releaseId(): string {
  const fromEnv = process.env.AIHOT_RELEASE;
  if (fromEnv) return fromEnv;
  const file = process.env.GEOHOT_RELEASE_FILE ?? fileURLToPath(new URL("../../../.release", import.meta.url));
  try {
    return readFileSync(file, "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    // Access logs never record query strings (tokens, actors). Fastify 5 moved the switch off the top
    // level into the log controller (the top-level spelling is deprecated and goes away in fastify@6):
    // same class, same sub-option the old key mapped to.
    logController: new LogController({ disableRequestLogging: true }),
    // Same flag, same reading as the web server (apps/web/server.ts:20): the per-IP caps on sign-in
    // attempts and feedback (routes/admin-auth.ts:36) only mean something when they key on the real
    // visitor, and a process exposed directly — with no proxy to set X-Forwarded-For — must not believe
    // a header any client can name. Off unless TRUST_PROXY=true says there is a proxy in front.
    // 2026-11-04 审计：`trustProxy: true` 把 X-Forwarded-For 的**最左段**当客户端，而 nginx 用
    // `$proxy_add_x_forwarded_for` 追加——最左段是请求方自己写的。任何人都能靠轮换这一行头把
    // 每 IP 600/min 的限流打成无限。这里只信本机反代（nginx 与 api 同机，源地址 127.0.0.1），
    // proxy-addr 于是取"最右边一个不可信地址"，也就是 nginx 真正看到的来访者。
    trustProxy: process.env.TRUST_PROXY === "true" ? ["127.0.0.1/32", "::1/128"] : false,
    genReqId: () => randomUUID(),
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 300 },
  });

  // Register before routes so every admin authentication read is protected. No path is exempted:
  // /api/admin/* shares the global per-IP cap like everything else (route-level overrides in
  // server-console.ts still win where they are tighter), which bounds a forged-flood or a runaway
  // admin tab to the same 600/min as the public read paths.
  // 2026-11-06 06:39 现场：部署验收在回环上连取十几个页面，每个页面的 SSR 又各打若干 API，
// 一下子越过 600/min，`/feed/*.xml` 拿到 429，验收与冒烟读到的是错误页 HTML。
// 回环不是读者：放行它，真实读者的每 IP 上限不变（Cloudflare 侧仍按 CF-Connecting-IP 记账）。
await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],
});
  app.addHook("onRequest", async (req) => {
    req.requestId = req.id;
  });

  app.addHook("onResponse", async (req, reply) => {
    const path = (req.raw.url ?? "").split("?")[0] ?? "/";
    // The reverse proxy logs every request; the process only notes the slow and the failed.
    const ms = Math.round(reply.elapsedTime);
    if (reply.statusCode >= 500 || (ms >= 1000 && path !== "/api/mcp" && !path.startsWith("/api/img-proxy"))) {
      req.log.warn({ method: req.method, path, status: reply.statusCode, ms }, "request");
    }
  });

  // Central redirect table (shared with the web server).
  app.addHook("onRequest", async (req, reply) => {
    const raw = req.raw.url ?? "/";
    const qi = raw.indexOf("?");
    const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
    const search = qi >= 0 ? raw.slice(qi) : "";
    if (OAUTH_PROBE_PATHS.includes(pathname)) {
      return reply.code(404).header("Cache-Control", "public, max-age=3600").type("application/json").send('{"error":"not_found"}');
    }
    const decision = resolveRedirect(pathname, search);
    if (decision) {
      for (const [k, v] of Object.entries(decision.headers)) reply.header(k, v);
      if (decision.location) return reply.code(decision.status).header("Location", decision.location).send();
      return reply.code(decision.status).type("text/plain; charset=utf-8").send(decision.status === 410 ? "Gone" : "Not found");
    }
  });

  app.get("/api/health", async (_req, reply) => {
    const started = Date.now();
    await sql`SELECT 1`;
    return reply.header("Cache-Control", "no-store").send({ ok: true, db: "ok", ms: Date.now() - started, release: releaseId() });
  });

  registerSite(app);
  if (FEATURES.leaderboard) registerLeaderboard(app);
  registerOg(app);
  registerAdminAuth(app);
  registerAdmin(app);
  await registerServerConsole(app);

  registerIngest(app);
  registerV1(app);
  registerMedia(app);

  registerFeeds(app);
  registerStatic(app);
  registerMcp(app);
  registerV1Fallbacks(app);

  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url ?? "").startsWith("/api/")) {
      return sendProblem(req, reply, { status: 404, code: "not_found", detail: "No such endpoint." });
    }
    return reply.code(404).type("text/plain; charset=utf-8").header("Cache-Control", "public, max-age=60").send("Not found");
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof CapacityExceeded) {
      reply.header("X-Accel-Expires", "0");
      return sendProblem(req, reply, { status: 429, code: "capacity_exhausted", detail: "Image rendering is busy; retry shortly.", retryAfter: 2 });
    }
    req.log.error({ err: error }, "unhandled");
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 400 || status === 413 || status === 415) {
      return sendProblem(req, reply, { status: status === 400 ? 400 : status, code: "invalid_request", detail: "The request could not be processed." });
    }
    return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Temporarily unavailable.", retryAfter: 30 });
  });

  return app;
}
