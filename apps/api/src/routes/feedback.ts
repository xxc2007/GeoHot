import type { FastifyInstance } from "fastify";
import { admitFeedback, FeedbackRejected, submitFeedback, type FeedbackInput } from "@aihot/backend/operations/feedback";
import { sendProblem } from "../http/respond.ts";

type FeedbackBody = Pick<FeedbackInput, "content" | "email" | "pageUrl" | "screenshot">;

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
        return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
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
      if (error instanceof FeedbackRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
      req.log.error({ err: error }, "feedback failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    }
  });
}
