// Signed image proxy. A request that cannot be honoured at all is 400; a bad or expired signature is 403.
// Neither ever reaches the upstream.
import type { FastifyInstance } from "fastify";
import { produceImage } from "@aihot/backend/media/images";
import { verifyProxyRequest, type VerifyResult } from "@aihot/backend/media/imgproxy";
import { looseQuery } from "../http/respond.ts";

/**
 * "Cannot be honoured at all" — no parameters, a `u` that is not a URL, or a mode nobody ever minted — is
 * the caller's mistake, so 400 (401 to an auth sub-request, which is how nginx reads "deny"). A bad or
 * expired signature is a refusal: 403. Neither kind reaches the upstream.
 */
const malformed = (v: VerifyResult): boolean => !v.ok && (v.reason === "missing" || v.reason === "bad-url" || v.reason === "bad-mode");

export function registerMedia(app: FastifyInstance) {
  app.get("/api/img-proxy", async (req, reply) => {
    const q = looseQuery(req);
    const verdict = verifyProxyRequest({ u: q.u, mode: q.mode, exp: q.exp, sig: q.sig });
    const badRequest = malformed(verdict);
    // A caching proxy (nginx auth_request) can check every request with this HEAD sub-request before it reads its image cache (keyed
    // by url and mode only): signature only, no upstream fetch. 401 = malformed query, 403 = bad or
    // expired signature; a valid answer may be cached for the rest of the signature's life.
    if (req.method === "HEAD" && req.headers["x-aihot-img-proxy-auth"] === "1") {
      if (!verdict.ok) {
        return reply.code(badRequest ? 401 : 403).header("Cache-Control", "no-store").header("X-Img-Proxy-Sig", verdict.reason === "expired" ? "expired" : "invalid").send();
      }
      const remaining = Math.max(1, Number(q.exp) - Math.floor(Date.now() / 1000));
      return reply.code(204).header("X-Img-Proxy-Sig", "valid").header("X-Accel-Expires", String(remaining)).send();
    }
    if (!verdict.ok) {
      return reply.code(badRequest ? 400 : 403).header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(badRequest ? "Bad request" : "Forbidden");
    }
    try {
      const { body, type } = await produceImage(verdict.url, verdict.mode);
      const maxAge = Math.max(60, Math.min(7 * 86400, Number(q.exp) - Math.floor(Date.now() / 1000)));
      return reply
        .header("Content-Type", type)
        .header("Cache-Control", `public, max-age=${maxAge}, s-maxage=${maxAge}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(body);
    } catch (error) {

      req.log.warn({ err: String(error), host: new URL(verdict.url).hostname }, "img-proxy upstream failed");
      return reply.code(502).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Upstream image unavailable");
    }
  });
}
