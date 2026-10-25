import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { config } from "@aihot/backend/config";
import { deployBase } from "@aihot/contracts/http-policy";
import { adminHandler } from "./admin-auth.ts";

export const magpiePrefix = () => `${deployBase(config.siteUrl)}/api/admin/magpie-proxy`;
/** Rewrite only the trusted, fixed loopback application's own resource URLs. */
export function embedMagpie(html: string, prefix: string, csrf: string) {
  const bootstrap = `<base href="${prefix}/"><script>(()=>{const base=${JSON.stringify(prefix)},csrf=${JSON.stringify(csrf)};const rewrite=(s)=>{const u=new URL(s,location.href);return u.origin===location.origin&&!u.pathname.startsWith(base+'/')?base+u.pathname+u.search+u.hash:u.href};const original=window.fetch;window.fetch=(input,init={})=>{const r=input instanceof Request?input:null;const h=new Headers(init.headers||(r&&r.headers)||{});if(!['GET','HEAD'].includes((init.method||(r&&r.method)||'GET').toUpperCase()))h.set('x-csrf-token',csrf);return original(r?new Request(rewrite(r.url),r):rewrite(String(input)),{...init,headers:h})};const ES=window.EventSource;if(ES)window.EventSource=class extends ES{constructor(url,options){super(rewrite(String(url)),options)}};})();</script>`;
  return html.replace(/(src|href|action)=(['"])\/(?!\/)/g, `$1=$2${prefix}/`).replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`);
}

export function registerServerConsole(app: FastifyInstance) {
  app.get("/api/admin/server", adminHandler(async (_req, reply) => {
    try {
      const text = await readFile(process.env.SERVER_STATUS_FILE || "/run/geohot-server/status.json", "utf8");
      if (text.length > 100_000) throw new Error("oversize sample");
      const sample = JSON.parse(text);
      return { ...sample, stale: Date.now() - Date.parse(sample.checkedAt) > 90_000 };
    } catch { return reply.code(503).send({ unavailable: true }); }
  }));
  app.route({ method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], url: "/api/admin/magpie-proxy/*", handler: adminHandler(async (req, reply, admin) => {
    const suffix = (req.params as { "*": string })["*"];
    // URL is never supplied by the caller; do not proxy the model gateway or token sign-in routes.
    if (!suffix || suffix === "index.html" || !/^(?:api\/|assets\/|[^/]+\.(?:js|css|svg|png|ico|woff2?)(?:$|\?))/.test(suffix)) {
      if (suffix && suffix !== "index.html") return reply.code(404).send({ error: "not_found" });
    }
    if (req.headers.origin && req.headers.origin !== new URL(config.siteUrl).origin) return reply.code(403).send({ error: "forbidden" });
    let secret: string;
    try { secret = (await readFile(process.env.MAGPIE_WEB_KEY_FILE || "/etc/geohot/magpie-web-key", "utf8")).trim(); }
    catch { return reply.code(503).send({ error: "magpie_unavailable" }); }
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const target = new URL(`/${suffix}${query}`, "http://127.0.0.1:3430");
    if (target.origin !== "http://127.0.0.1:3430" || target.searchParams.has("k") || target.pathname.startsWith('/v1') || target.pathname.startsWith('/_magpie')) return reply.code(400).send({ error: "invalid_path" });
    const headers: Record<string, string> = { cookie: `magpie_web_3430=${secret}`, "accept-encoding": "identity", origin: "http://127.0.0.1:3430" };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    try {
      const upstream = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body), redirect: "manual", signal: AbortSignal.timeout(20_000) });
      reply.header("Cache-Control", "no-store").header("X-Frame-Options", "SAMEORIGIN").header("Content-Security-Policy", "frame-ancestors 'self'");
      if (upstream.headers.has("location")) return reply.code(upstream.status).header("Location", magpiePrefix() + new URL(upstream.headers.get("location")!, target).pathname).send();
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (contentType.includes("text/event-stream")) {
        reply.type(contentType);
        if (!upstream.body) return reply.send();
        return reply.send(Readable.fromWeb(upstream.body as never));
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > 8_000_000) return reply.code(502).send({ error: "response_too_large" });
      reply.code(upstream.status).type(contentType);
      return contentType.includes("text/html") ? embedMagpie(bytes.toString("utf8"), magpiePrefix(), admin.csrf) : bytes;
    } catch { return reply.code(503).send({ error: "magpie_unavailable" }); }
  }) });
}
