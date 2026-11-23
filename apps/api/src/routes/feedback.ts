import type { FastifyInstance, FastifyRequest } from "fastify";
import { admitFeedback, FeedbackRejected, feedbackStatus, submitFeedback, type FeedbackInput } from "@aihot/backend/operations/feedback";
import { sendProblem, looseQuery } from "../http/respond.ts";

type FeedbackBody = Pick<FeedbackInput, "content" | "email" | "pageUrl" | "screenshot">;

// Status lookups key on the client address, same shape as the submission limiter: bounded identities,
// so one address cannot walk the id space faster than a few per minute. Small on purpose — a reader
// checks their own number once, not ten times.
const recentLookups = new Map<string, number[]>();
function admitLookup(ip: string): boolean {
  const now = Date.now();
  const list = (recentLookups.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 20) return false;
  list.push(now);
  recentLookups.set(ip, list);
  if (recentLookups.size > 5_000) for (const [k, v] of recentLookups) if (!v.length || now - v[v.length - 1]! > 120_000) recentLookups.delete(k);
  return true;
}

/** 状态以中文展示给读者（后台仍是英文枚举，二者各自唯一）。 */
const STATUS_ZH: Record<string, string> = { new: "已收到", triaged: "处理中", replied: "已回复", resolved: "已解决", spam: "已收到" };
/** `/en` 的状态词；未知状态原样透出，不编一个新词。 */
const STATUS_EN: Record<string, string> = { new: "Received", triaged: "In progress", replied: "Replied", resolved: "Resolved", spam: "Received" };

function feedbackLang(req: FastifyRequest): "zh" | "en" {
  return looseQuery(req).lang === "en" ? "en" : "zh";
}

/**
 * 错误的英文文案按 code 走；中文保持 operations 层写好的具体句子（旧字段语义不变）。
 * 前端拿 code 也能自行出词，`detail` 只是兜底。
 */
function detailFor(code: string, zh: string, lang: "zh" | "en"): string {
  if (lang !== "en") return zh;
  if (code === "rate_limited") return "Too many requests; please try again later.";
  if (code === "temporarily_unavailable") return "Feedback is temporarily unavailable; please try again later.";
  return "Please check the submitted content and try again.";
}

async function readBody(raw: unknown, contentType: string): Promise<FeedbackBody> {
  if (Buffer.isBuffer(raw)) {
    let form: FormData;
    try {
      form = await new Response(raw as Buffer<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确，请重新提交。");
    }
    const text = (key: string) => {
      const value = form.get(key);
      if (value !== null && typeof value !== "string") throw new FeedbackRejected(400, "invalid_request", "反馈文字格式不正确。");
      return value;
    };
    const file = form.get("screenshot");
    if (file !== null && !(file instanceof File)) throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确。");
    return {
      content: text("content") ?? "", email: text("email"), pageUrl: text("pageUrl"),
      screenshot: file ? { mime: file.type, data: Buffer.from(await file.arrayBuffer()) } : null,
    };
  }
  // Keep already-open browser tabs working during a release: their JSON/base64 requests still work.
  const body = (raw ?? {}) as { content?: string; email?: string; pageUrl?: string; screenshot?: { mime?: string; data?: string } };
  return {
    content: String(body.content ?? ""), email: body.email ?? null, pageUrl: body.pageUrl ?? null,
    screenshot: body.screenshot?.data && body.screenshot.mime ? { mime: body.screenshot.mime, data: Buffer.from(body.screenshot.data, "base64") } : null,
  };
}

export function registerFeedback(app: FastifyInstance, uploadDeadlineMs = 15_000) {
  const admitted = new WeakMap<object, ReturnType<typeof admitFeedback>>();
  const deadlines = new WeakMap<object, ReturnType<typeof setTimeout>>();
  const clearDeadline = (req: object) => { clearTimeout(deadlines.get(req)); deadlines.delete(req); };
  const release = (req: object) => { clearDeadline(req); admitted.get(req)?.release(); admitted.delete(req); };
  // Bounded by the same request limit as JSON; native multipart parsing avoids base64 on the wire.
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/api/site/feedback", {
    bodyLimit: 12 * 1024 * 1024,
    onRequest: async (req, reply) => {
      const forwarded = process.env.TRUST_PROXY === "true" ? req.headers["x-real-ip"] : undefined;
      try {
        admitted.set(req, admitFeedback(String(forwarded ?? req.ip ?? "")));
        // Absolute upload deadline, rather than inactivity: trickling bytes cannot hold both slots.
        const timer = setTimeout(() => { req.raw.destroy(); release(req); }, uploadDeadlineMs);
        timer.unref();
        deadlines.set(req, timer);
      }
      catch (error) {
        if (!(error instanceof FeedbackRejected)) throw error;
        return sendProblem(req, reply, { status: error.status, code: error.code, detail: detailFor(error.code, error.message, feedbackLang(req)), retryAfter: error.retryAfter });
      }
    },
    preValidation: async (req) => { clearDeadline(req); },
    onResponse: async (req) => { release(req); },
    onRequestAbort: async (req) => { release(req); },
    onError: async (req) => { release(req); },
  }, async (req, reply) => {
    try {
      const body = await readBody(req.body, String(req.headers["content-type"] ?? ""));
      // The per-reader limit and the ban list key on the client address. `X-Real-IP` is a header any client
      // can name, so it is believed only when TRUST_PROXY says a proxy in front overwrites it (app.ts sets
      // Fastify's own trustProxy from the same value); otherwise the socket address is the truth.
      const forwarded = process.env.TRUST_PROXY === "true" ? req.headers["x-real-ip"] : undefined;
      const ip = String(forwarded ?? req.ip ?? "");
      const result = await submitFeedback({ ...body, ip, userAgent: String(req.headers["user-agent"] ?? "") }, admitted.get(req)?.ticket);
      return reply.header("Cache-Control", "no-store").code(201).send(result);
    } catch (error) {
      if (error instanceof FeedbackRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: detailFor(error.code, error.message, feedbackLang(req)), retryAfter: error.retryAfter });
      req.log.error({ err: error }, "feedback failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: detailFor("temporarily_unavailable", "暂时无法提交，请稍后再试。", feedbackLang(req)), retryAfter: 30 });
    }
  });

  // Reader-side status lookup: feedback number + the email it was submitted with. The answer is one
  // status word or a generic not-found — never the row itself — and it is rate limited per address.
  app.get("/api/site/feedback-status", async (req, reply) => {
    const forwarded = process.env.TRUST_PROXY === "true" ? req.headers["x-real-ip"] : undefined;
    const ip = String(forwarded ?? req.ip ?? "");
    const q = (req.query ?? {}) as { id?: string; email?: string };
    const id = Number(q.id);
    const email = (q.email ?? "").trim() || null;
    if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return reply.header("Cache-Control", "no-store").code(404).send({ status: null });
    if (!admitLookup(ip)) return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: detailFor("rate_limited", "查询太频繁，请稍后再试。", feedbackLang(req)), retryAfter: 60 });
    const result = await feedbackStatus(id, email);
    const lang = feedbackLang(req);
    const words = lang === "en" ? STATUS_EN : STATUS_ZH;
    return reply.header("Cache-Control", "no-store").send({
      status: result ? (words[result.status] ?? result.status) : null,
      // 机器可读的状态码（后台英文枚举）；前端按自己的字典出词，`status` 只是兜底文案。
      code: result?.status ?? null,
    });
  });
}
