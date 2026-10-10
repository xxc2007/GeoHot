// External collection scripts push items here (docs/sources.md). They use the ingest
// token (never an admin session) and their own rate limit.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { credential } from "@aihot/backend/config";
import { IngestError, ingestItems } from "@aihot/backend/ingest/items";


const PLACEHOLDER = /^(|changeme|change-me|placeholder|xxx+|todo|test|dev|your[-_]?token.*)$/i;

/** Constant-time check; an empty or placeholder server token rejects everything. */
function authorized(req: FastifyRequest): boolean {
  const expected = credential("auth", "INGEST_TOKEN") ?? "";
  if (PLACEHOLDER.test(expected) || expected.length < 16) return false;
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const windows = new Map<string, number[]>();
function limited(key: string, perMinute: number): boolean {
  const now = Date.now();
  if (windows.size > 5000) {
    // 与 admin 登录那处同一个形状：轮换 IP 就能把这张表撑大，而它只服务限速，不服务正确性——
    // 清掉过期客户端的记录即可，被清空的那一格最坏只是重新开始计数（多放行一分钟）。
    for (const [k, times] of windows) {
      if (times.every((t) => now - t >= 60_000)) windows.delete(k);
    }
    if (windows.size > 5000) windows.clear();
  }
  const list = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) return true;
  list.push(now);
  windows.set(key, list);
  return false;
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Unauthorized");
}

export function registerIngest(app: FastifyInstance) {
  app.post("/api/ingest/items", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!authorized(req)) return unauthorized(reply);
    if (limited(`items:${req.ip}`, 10)) return reply.code(429).header("Retry-After", "60").send({ ok: false, error: "rate limited" });
    try {
      return await ingestItems((req.body ?? {}) as never);
    } catch (error) {
      if (error instanceof IngestError) return reply.code(error.status).send({ ok: false, error: error.message });
      req.log.error({ err: error }, "ingest items failed");
      return reply.code(500).send({ ok: false, error: "internal error" });
    }
  });
}
