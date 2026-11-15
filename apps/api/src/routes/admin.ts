// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf } from "@aihot/backend/admin/auth";
import { InvalidInput } from "@aihot/backend/admin/invalid";
import { sharedAdminRead } from "@aihot/backend/admin/read-cache";

import { cachePage } from "@aihot/backend/admin/page-cache";
import { MicroCache } from "@aihot/backend/lib/micro-cache";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { usageOverview } from "@aihot/backend/admin/usage";

import { contentChain, detachFromFact, mergeStories, overrideFields, rerun, rewriteStoryDigest, searchContent, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { eraseFeedback, feedbackScreenshot, listFeedback, replyFeedback, updateFeedback } from "@aihot/backend/admin/feedback";
import { releaseReceipt, requeueFailedArticles, readRunsOverview } from "@aihot/backend/admin/runs";
import { deleteBudget, listBudgets, updateBudget } from "@aihot/backend/admin/settings";
import { createSource, fetchNow, listSources, previewSource, setSourceTarget, sourceDetail, sourceRegistryPolicy, updateSource, replaceSources } from "@aihot/backend/admin/sources";
import { sql } from "@aihot/backend/db";
import { sendProblem } from "../http/respond.ts";
import { adminReadOrBusy } from "@aihot/backend/admin/admin-read";
import { topicRotationBoard } from "@aihot/backend/admin/topic-rotation";
import { adminHandler } from "./admin-auth.ts";

type Q = Record<string, string | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
/**
 * 2026-11-04 独立审计 ②：`?page=1e999` 会被 `Number()` 变成 `Infinity`，乘 100 之后交给
 * `OFFSET`，Postgres 直接报 `invalid input syntax` —— 对操作者表现为 500，对爬虫表现为
 * 「随便试试就能打崩一页」。这里同时挡住非有限值和过大的页码。
 */
const PAGE_MAX = 500;
const page = (req: FastifyRequest) => {
  const raw = Number(q(req).page);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(PAGE_MAX, Math.max(1, Math.trunc(raw)));
};

/**
 * A numeric :id from the path. Number() of "abc" is NaN, and a NaN compared against a bigint column is
 * a Postgres error the operator would be told about as a server fault.
 */
const rowId = (req: FastifyRequest) => {
  const raw = param(req, "id");
  if (!/^\d{1,9}$/.test(raw)) throw new InvalidInput(`地址里的编号 ${raw.slice(0, 24)} 不是数字`);
  return Number(raw);
};
const idOf = (value: unknown, name: string) => {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) throw new InvalidInput(`${name} 必须是数字`);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidInput(`${name} 必须是数字`);
  return n;
};

export function registerAdmin(app: FastifyInstance) {
  app.post("/api/admin/sources/replace", adminHandler(async (req, _reply, admin) => replaceSources(body(req) as never, actorOf(admin))));
  // Sources (F18)
  app.get("/api/admin/sources", adminHandler(async (req) => {
    const f = q(req);
    return listSources({ q: f.q, kind: f.kind, health: f.health, mode: f.mode, enabled: f.enabled as "true" | "false" | undefined, page: page(req) });
  }));
  app.post("/api/admin/sources", adminHandler(async (req, _reply, admin) => createSource(body(req), actorOf(admin))));
  app.post("/api/admin/sources/preview", adminHandler(async (req) => previewSource(body(req) as never)));
  // 2026-11-15：站长要「2000 条信源、1000 正式、1000 备用，且能自己调」。
  // 目标值单独一条路由，改动只动 policy（不动任何信源），并写审计。
  app.get("/api/admin/sources/policy", adminHandler(async () => sourceRegistryPolicy()));
  app.post("/api/admin/sources/policy", adminHandler(async (req, _reply, admin) => setSourceTarget(body(req), actorOf(admin))));
  app.get("/api/admin/sources/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await sourceDetail(param(req, "id")))));
  app.patch("/api/admin/sources/:id", adminHandler(async (req, reply, admin) => {
    const b = body<{ patch: unknown; version: string; reason?: string }>(req);
    return orNotFound(req, reply, await updateSource(param(req, "id"), b, actorOf(admin)));
  }));
  app.post("/api/admin/sources/:id/preview", adminHandler(async (req, reply) => {
    const [s] = await sql`SELECT * FROM sources WHERE id = ${param(req, "id")}`;
    return s ? previewSource(s as never) : notFound(req, reply);
  }));
  app.post("/api/admin/sources/:id/fetch", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await fetchNow(param(req, "id"), actorOf(admin)))));

  // Content and events (F19)
  app.get("/api/admin/content", adminHandler(async (req) => await searchContent(q(req).q ?? "", Number(q(req).limit ?? 60) || 60)));
  app.get("/api/admin/content/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await contentChain(param(req, "id")))));
  app.post("/api/admin/content/:id/visibility", adminHandler(async (req, _reply, admin) => setVisibility(param(req, "id"), body(req), actorOf(admin))));
  app.post("/api/admin/content/:id/seo", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await setSeoIndexed(param(req, "id"), body(req), actorOf(admin)))));
  app.post("/api/admin/content/:id/override", adminHandler(async (req, _reply, admin) => overrideFields(param(req, "id"), body(req), actorOf(admin))));
  app.post("/api/admin/content/:id/rerun", adminHandler(async (req, reply, admin) => {
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await rerun(param(req, "id"), body(req), requestId, actorOf(admin)));
  }));
  app.post("/api/admin/content/:id/detach", adminHandler(async (req, _reply, admin) => detachFromFact(param(req, "id"), String(body(req).reason ?? ""), actorOf(admin))));
  app.post("/api/admin/stories/:id/digest", adminHandler(async (req, reply, admin) => {
    const b = body<{ reason: string }>(req);
    // The key the back office puts on every command is what makes two clicks two rewrites: the paid
    // call's dedupe is keyed on it (see `composeStoryDigest`), the double-click guard is the queue's.
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await rewriteStoryDigest(idOf(param(req, "id"), "id"), String(b.reason ?? ""), requestId, actorOf(admin)));
  }));
  app.post("/api/admin/stories/merge", adminHandler(async (req, _reply, admin) => {
    const b = body<{ from: number; into: number; reason: string }>(req);
    return mergeStories(idOf(b.from, "from"), idOf(b.into, "into"), String(b.reason ?? ""), actorOf(admin));
  }));

  // Feedback
  app.get("/api/admin/feedback", adminHandler(async (req) => listFeedback({ status: q(req).status, q: q(req).q, page: page(req) })));
  app.patch("/api/admin/feedback/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateFeedback(rowId(req), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/feedback/:id/erase", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await eraseFeedback(rowId(req), String(body(req).reason ?? ""), actorOf(admin)))));
  app.get("/api/admin/feedback/:id/screenshot", adminHandler(async (req, reply) => {
    const file = await feedbackScreenshot(rowId(req));
    const data = file ? await readFile(file).catch(() => null) : null;
    if (!data) return notFound(req, reply);
    const ext = file!.split(".").pop();
    // The type comes from the stored file's extension; nosniff keeps a browser from second-guessing it.
    return reply.type(ext === "jpeg" || ext === "jpg" ? "image/jpeg" : `image/${ext}`).header("X-Content-Type-Options", "nosniff").send(data);
  }));

  // Runs (F20)
  app.get("/api/admin/runs", adminHandler(async () => readRunsOverview()));
  app.post("/api/admin/receipts/:id/release", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await releaseReceipt(rowId(req), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/processing/requeue", adminHandler(async (req, _reply, admin) => requeueFailedArticles(body(req) as never, actorOf(admin))));

  // Operator reply to one feedback, from the site mailbox to the reader's address.
  app.post("/api/admin/feedback/:id/reply", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await replyFeedback(rowId(req), body(req) as never, actorOf(admin)))));

  // Settings
  // 后台是「人看一眼」的页面：30 秒内重复打开直接给缓存，过期的旧值先给、后台重算（io 打满时不再 503）。
  app.get("/api/admin/settings", adminHandler(async () => cachePage("settings", "all", async () => ({ budgets: await listBudgets() }), { freshMs: 30_000 })));
  app.get("/api/admin/topics", adminHandler(async (req) => { const days = Math.min(365, Number(q(req).days) || 30); return cachePage("topics", String(days), () => topicRotationBoard(days), { freshMs: 120_000 }); }));
  app.put("/api/admin/budgets/:service", adminHandler(async (req, _reply, admin) => updateBudget(param(req, "service"), body(req) as never, actorOf(admin))));
  // 只删预算行（retire 一扇门）：receipts / receipt_attempts / metrics 历史不动（是账单与审计依据）。
  app.delete("/api/admin/budgets/:service", adminHandler(async (req, reply, admin) => {
    const b = body<{ reason: string }>(req);
    return orNotFound(req, reply, await deleteBudget(param(req, "service"), b.reason, actorOf(admin)));
  }));


  // Models and evaluation (F20)
  app.get("/api/admin/models", adminHandler(async (req) => { const days = Math.min(90, Number(q(req).days) || 7); return cachePage("models", String(days), () => modelsOverview(days), { freshMs: 120_000 }); }));
  // 后台的「用量总览」是几条按天/按小时聚合的大查询，在这块慢盘上单次要几十秒；
  // 页面每 30 秒自动刷新一次，等于把同一份聚合反复算。这里给结果做一层进程内缓存：
  //   命中（60 秒内）直接给；过期的旧值也先给，同时后台重算；重算失败仍给旧值（带 x-admin-cache: stale）。
  const usageCache = new MicroCache<Awaited<ReturnType<typeof usageOverview>>>({ freshMs: 60_000, staleMs: 30 * 60_000, maxEntries: 64 });
  const usagePending = new Map<string, Promise<Awaited<ReturnType<typeof usageOverview>>>>();
  const refreshUsage = (key: string, args: Parameters<typeof usageOverview>) => {
    if (usagePending.has(key)) return usagePending.get(key)!;
    const run = usageOverview(...args)
      .then((data) => { usageCache.write(key, data); return data; })
      .finally(() => usagePending.delete(key));
    usagePending.set(key, run);
    return run;
  };
  app.get("/api/admin/usage", adminHandler(async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const f = q(req);
    const args = [f.range, f.service, f.model, f.date, f.month] as Parameters<typeof usageOverview>;
    const key = args.map((v) => v ?? "").join("|");
    const hit = usageCache.read(key);
    if (hit?.fresh) { reply.header("x-admin-cache", "fresh"); return hit.data; }
    if (hit) {
      void refreshUsage(key, args).catch(() => {});
      reply.header("x-admin-cache", "stale");
      return hit.data;
    }
    try {
      const data = await refreshUsage(key, args);
      reply.header("x-admin-cache", "miss");
      return data;
    } catch (error) {
      const again = usageCache.read(key);
      if (again) { reply.header("x-admin-cache", "stale-error"); return again.data; }
      throw error;
    }
  }));
  app.post("/api/admin/models/:capability", adminHandler(async (req, _reply, admin) => {
    const b = body<{ model: string | null; reason: string }>(req);
    return switchModel(param(req, "capability"), b.model ?? null, String(b.reason ?? ""), actorOf(admin));
  }));

  // Attention counts for the navigation. The monitor column is gated like the routes above: counting
  // rows in a module this site does not run would light up a badge the operator cannot clear.
  const readNavCounts = sharedAdminRead(10_000, () => sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '1000ms'`;
    await tx`SET LOCAL lock_timeout = '250ms'`;
    await tx`SET LOCAL max_parallel_workers_per_gather = 0`;
    const [c] = await tx<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM feedback WHERE status = 'new') AS feedback,
             (SELECT count(*)::int FROM sources WHERE enabled AND health = 'failing') AS sources,
             (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS runs,
             0 AS monitor`;
    return c;
  }));
  app.get("/api/admin/nav-counts", adminHandler(async () => readNavCounts()));

  // Audit trail
  // 审计列表也走 adminRead：它读的是最深的表（OFFSET 可到 49,900），裸 sql 没有 statement_timeout，
  // 一次慢查询就把后台挂在 5 秒之外（同型问题在 admin-read.ts 已收口）。
  app.get("/api/admin/audit", adminHandler(async (req) => {
    const f = q(req);
    const pageNo = page(req);
    // 审计首页也是「人看一眼」的数据：同一组筛选 30 秒内重复打开不再打数据库（慢盘上它最容易 503）。
    return cachePage("audit", [f.subject ?? "", f.action ?? "", String(pageNo)].join("|"), () => readAudit(f, pageNo), { freshMs: 30_000 });
  }));
  const readAudit = async (f: ReturnType<typeof q>, pageNo: number) => {
    const rows = await adminReadOrBusy((db) => db`
      SELECT id, created_at, actor, action, subject, reason, before, after FROM audit_log
      WHERE (${f.subject ?? null}::text IS NULL OR subject = ${f.subject ?? null}) AND (${f.action ?? null}::text IS NULL OR action LIKE ${`${f.action ?? ""}%`})
      ORDER BY created_at DESC LIMIT 101 OFFSET ${(pageNo - 1) * 100}`);
    // 101 行只为回答「还有没有下一页」：后台按「这页满 100 条」推断，尾页正好满 100 时点下一页是空表。
    return { page: pageNo, rows: rows.slice(0, 100), hasMore: rows.length > 100 };
  };
}
