import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { request as httpRequest } from "node:http";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { config } from "@aihot/backend/config";
import { deployBase } from "@aihot/contracts/http-policy";
import { sessionPrincipal } from "@aihot/backend/admin/auth";
import { adminHandler } from "./admin-auth.ts";

export const magpiePrefix = () => `${deployBase(config.siteUrl)}/api/admin/magpie-proxy`;
function scriptString(value: string) {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
async function magpieRequest(resource: string, init: {method:string;headers:Record<string,string>;body?:string}):Promise<Response> {
  return new Promise((resolve, reject) => {
    // Keep host/port constants separate from the resource path, including after URL normalization.
    const call = httpRequest({ hostname:'127.0.0.1', port:3430, path:resource, method:init.method, headers:init.headers }, res => {
      const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
      resolve(new Response([204,304].includes(res.statusCode??200)?null:Readable.toWeb(res) as never,{status:res.statusCode??502,headers}));
    });
    call.setTimeout(20_000,()=>call.destroy(new Error('Magpie timeout')));call.on('error',reject);call.end(init.body);
  });
}
/** Rewrite only the trusted, fixed loopback application's own resource URLs. */
export function embedMagpie(html: string, prefix: string, csrf: string) {
  if(!/^\/[a-zA-Z0-9/_-]+$/.test(prefix))throw new Error('invalid Magpie deployment prefix');
  const bootstrap = `<base href="${prefix}/"><script>(()=>{const base=${scriptString(prefix)},csrf=${scriptString(csrf)};const rewrite=(s)=>{const u=new URL(s,location.href);return u.origin===location.origin&&!u.pathname.startsWith(base+'/')?base+u.pathname+u.search+u.hash:u.href};const original=window.fetch;window.fetch=(input,init={})=>{const r=input instanceof Request?input:null;const h=new Headers(init.headers||(r&&r.headers)||{});if(!['GET','HEAD'].includes((init.method||(r&&r.method)||'GET').toUpperCase()))h.set('x-csrf-token',csrf);return original(r?new Request(rewrite(r.url),r):rewrite(String(input)),{...init,headers:h})};const ES=window.EventSource;if(ES)window.EventSource=class extends ES{constructor(url,options){super(rewrite(String(url)),options)}};})();</script>`;
  const readiness = `<script>(()=>{const base=${scriptString(prefix)};let failed=false,sent=false;const send=(state)=>parent.postMessage({type:'geohot:magpie:'+state},location.origin);const check=()=>{if(!failed&&!sent&&document.getElementById('pageTitle')?.textContent?.trim()){sent=true;send('ready')}};const fix=(node)=>{if(!(node instanceof Element))return;for(const el of [node,...node.querySelectorAll('[src]')]){const src=el.getAttribute('src');if(src&&src.startsWith('/')&&!src.startsWith('//')&&!src.startsWith(base+'/'))el.setAttribute('src',base+src)}};new MutationObserver(records=>{for(const r of records){if(r.type==='attributes')fix(r.target);else for(const n of r.addedNodes)fix(n)}check()}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});addEventListener('load',()=>{fix(document.documentElement);check()},{once:true});addEventListener('error',e=>{if(e.target instanceof HTMLScriptElement){failed=true;send('failed')}},true);})();</script>`;
  return html.replace(/(src|href|action)=(['"])\/(?!\/)/g, `$1=$2${prefix}/`).replace(/<head([^>]*)>/i, `<head$1>${bootstrap}${readiness}`);
}

export async function registerServerConsole(app: FastifyInstance, forward = magpieRequest, authenticate: typeof sessionPrincipal = sessionPrincipal) {
  const guard = (fn: Parameters<typeof adminHandler>[0]) => adminHandler(fn, authenticate);
  if (!app.hasDecorator('rateLimit')) await app.register(rateLimit, { global:true, max:600, timeWindow:'1 minute' });
  app.get("/api/admin/server", {config:{rateLimit:{max:30,timeWindow:'1 minute'}}}, guard(async (_req, reply) => {
    try {
      const text = await readFile(process.env.SERVER_STATUS_FILE || "/run/geohot-server/status.json", "utf8");
      if (text.length > 100_000) throw new Error("oversize sample");
      const sample = JSON.parse(text);
      return { ...sample, stale: Date.now() - Date.parse(sample.checkedAt) > 90_000 };
    } catch { return reply.code(503).send({ unavailable: true }); }
  }));
  app.route({ method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], url: "/api/admin/magpie-proxy/*", config:{rateLimit:{max:240,timeWindow:'1 minute'}}, handler: guard(async (req, reply, admin) => {
    const suffix = (req.params as { "*": string })["*"];
    // URL is never supplied by the caller; do not proxy the model gateway or token sign-in routes.
    const staticResource = /^(?:(?:assets|plugins|fonts)\/)?[a-zA-Z0-9_./-]+\.(?:js|css|svg|png|ico|woff2?|ttf)$/.test(suffix);
    if (suffix && suffix !== "index.html" && !suffix.startsWith("api/") && !staticResource) return reply.code(404).send({ error: "not_found" });
    if (suffix.split('/').some(part => part === '.' || part === '..') || suffix.includes('\\')) return reply.code(400).send({ error: "invalid_path" });
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
      const upstream = await forward(target.pathname+target.search, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body) });
      reply.header("Cache-Control", "no-store").header("X-Frame-Options", "SAMEORIGIN").header("Content-Security-Policy", "frame-ancestors 'self'");
      if (upstream.headers.has("location")) {
        const next = new URL(upstream.headers.get("location")!, target);
        if (next.origin !== target.origin) return reply.code(502).send({ error: "invalid_redirect" });
        return reply.code(upstream.status).header("Location", magpiePrefix() + next.pathname + next.search).send();
      }
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (staticResource && upstream.ok && !contentType.includes("text/html")) reply.header("Cache-Control", target.searchParams.has('v') ? "private, max-age=86400, immutable" : "private, max-age=60");
      if (contentType.includes("text/event-stream")) {
        reply.type(contentType);
        if (!upstream.body) return reply.send();
        return reply.send(Readable.fromWeb(upstream.body as never));
      }
      const chunks: Uint8Array[] = []; let size = 0;
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > 8_000_000) { await reader.cancel(); return reply.code(502).send({ error: "response_too_large" }); }
          chunks.push(part.value);
        } } finally { reader.releaseLock(); }
      }
      const bytes = Buffer.concat(chunks);
      reply.code(upstream.status).type(contentType);
      return contentType.includes("text/html") ? embedMagpie(bytes.toString("utf8"), magpiePrefix(), admin.csrf) : bytes;
    } catch { return reply.code(503).send({ error: "magpie_unavailable" }); }
  }) });
}
