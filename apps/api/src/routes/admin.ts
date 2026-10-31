// /api/admin/*: queries are GET, creation POST, edits PATCH, business commands POST.
// Every route goes through adminHandler (session + CSRF); manual changes are audited in the modules.
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf } from "@aihot/backend/admin/auth";
import { InvalidInput } from "@aihot/backend/admin/invalid";
import { sharedAdminRead } from "@aihot/backend/admin/read-cache";

import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { usageOverview } from "@aihot/backend/admin/usage";

import { contentChain, detachFromFact, mergeStories, overrideFields, rerun, rewriteStoryDigest, searchContent, setSeoIndexed, setVisibility } from "@aihot/backend/admin/content";
import { eraseFeedback, feedbackScreenshot, listFeedback, updateFeedback } from "@aihot/backend/admin/feedback";
import { releaseReceipt, requeueFailedArticles, resolveDelivery, readRunsOverview } from "@aihot/backend/admin/runs";
import { deleteBudget, listBudgets, updateBudget } from "@aihot/backend/admin/settings";
import { createSource, fetchNow, listSources, previewSource, sourceDetail, updateSource, replaceSources } from "@aihot/backend/admin/sources";
import { sql } from "@aihot/backend/db";
import { sendProblem } from "../http/respond.ts";
import { adminHandler } from "./admin-auth.ts";

type Q = Record<string, string | undefined>;
const q = (req: FastifyRequest) => req.query as Q;
const body = <T = Record<string, unknown>>(req: FastifyRequest) => (req.body ?? {}) as T;
const param = (req: FastifyRequest, name: string) => (req.params as Record<string, string>)[name]!;
const notFound = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: "not_found", detail: "Not found." });
const orNotFound = <T>(req: FastifyRequest, reply: FastifyReply, value: T | null) => (value === null || value === undefined ? notFound(req, reply) : value);
const page = (req: FastifyRequest) => Math.max(1, Number(q(req).page) || 1);

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
  app.get("/api/admin/content", adminHandler(async (req) => ({ rows: await searchContent(q(req).q ?? "") })));
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
    return reply.type(ext === "jpeg" || ext === "jpg" ? "image/jpeg" : `image/${ext}`).send(data);
  }));

  // Runs (F20)
  app.get("/api/admin/runs", adminHandler(async () => readRunsOverview()));
  app.post("/api/admin/receipts/:id/release", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await releaseReceipt(rowId(req), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/deliveries/:id/resolve", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await resolveDelivery(rowId(req), body(req) as never, actorOf(admin)))));
  app.post("/api/admin/processing/requeue", adminHandler(async (req, _reply, admin) => requeueFailedArticles(body(req) as never, actorOf(admin))));

  // Settings
  app.get("/api/admin/settings", adminHandler(async () => ({ budgets: await listBudgets() })));
  app.put("/api/admin/budgets/:service", adminHandler(async (req, _reply, admin) => updateBudget(param(req, "service"), body(req) as never, actorOf(admin))));
  // 只删预算行（retire 一扇门）：receipts / receipt_attempts / metrics 历史不动（是账单与审计依据）。
  app.delete("/api/admin/budgets/:service", adminHandler(async (req, reply, admin) => {
    const b = body<{ reason: string }>(req);
    return orNotFound(req, reply, await deleteBudget(param(req, "service"), b.reason, actorOf(admin)));
  }));


  // Models and evaluation (F20)
  app.get("/api/admin/models", adminHandler(async (req) => modelsOverview(Math.min(90, Number(q(req).days) || 7))));
  app.get("/api/admin/usage", adminHandler(async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return usageOverview(q(req).range,q(req).service,q(req).model,q(req).date,q(req).month);
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
             (SELECT count(*)::int FROM receipts WHERE status = 'unknown') + (SELECT count(*)::int FROM deliveries WHERE status = 'unknown') AS runs,
             0 AS monitor`;
    return c;
  }));
  app.get("/api/admin/nav-counts", adminHandler(async () => readNavCounts()));

  // Audit trail
  app.get("/api/admin/audit", adminHandler(async (req) => {
    const f = q(req);
    const rows = await sql`
      SELECT id, created_at, actor, action, subject, reason, before, after FROM audit_log
      WHERE (${f.subject ?? null}::text IS NULL OR subject = ${f.subject ?? null}) AND (${f.action ?? null}::text IS NULL OR action LIKE ${`${f.action ?? ""}%`})
      ORDER BY created_at DESC LIMIT 100 OFFSET ${(page(req) - 1) * 100}`;
    return { page: page(req), rows };
  }));
}
