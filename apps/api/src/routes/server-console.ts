import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { request as httpRequest } from "node:http";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { deployBase } from "@aihot/contracts/http-policy";
import { sessionPrincipal } from "@aihot/backend/admin/auth";
import { adminHandler } from "./admin-auth.ts";

export const magpiePrefix = () => `${deployBase(config.siteUrl)}/api/admin/magpie-proxy`;
function scriptString(value: string) {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
/**
 * Magpie 控制台上游可配置（MAGPIE_WEB_BASE_URL），默认兼容旧的本地 3430。
 * 只允许 http loopback（127.0.0.1/127.x/localhost/::1），不接受真实公网 IP；
 * 跨机访问走本机 SSH 隧道端口，不在代理里硬编码对端地址。
 */
export function magpieBase(): URL {
  const raw = process.env.MAGPIE_WEB_BASE_URL || "http://127.0.0.1:3430";
  const u = new URL(raw);
  const host = u.hostname;
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (u.protocol !== "http:" || !loopback) throw new Error("magpie upstream must be http loopback");
  return u;
}
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Cookie 优先取 MAGPIE_WEB_COOKIE，否则读既有 web key 文件；不把密钥回传给浏览器。 */
async function magpieCookie(): Promise<string> {
  const envCookie = process.env.MAGPIE_WEB_COOKIE?.trim();
  if (envCookie) return envCookie;
  return (await readFile(process.env.MAGPIE_WEB_KEY_FILE || "/etc/geohot/magpie-web-key", "utf8")).trim();
}

export async function magpieRequest(resource: string, init: {method:string;headers:Record<string,string>;body?:string}):Promise<Response> {
  const base = magpieBase();
  return new Promise((resolve, reject) => {
    const target = new URL(resource, base);
    // Magpie deliberately holds an idle trace poll for 25 seconds. Keep its deadline
    // above that interval, but below the reverse proxy's 60-second read timeout.
    const idlePoll = target.pathname === "/api/gateway/trace" && target.searchParams.get("wait") === "1";
    const call = httpRequest({ hostname:base.hostname, port:Number(base.port)||80, path:resource, method:init.method, headers:init.headers }, res => {
      const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
      resolve(new Response([204,304].includes(res.statusCode??200)?null:Readable.toWeb(res) as never,{status:res.statusCode??502,headers}));
    });
    call.setTimeout(idlePoll ? 45_000 : 20_000,()=>call.destroy(new Error("Magpie timeout")));call.on("error",reject);call.end(init.body);
  });
}
/** Rewrite only the trusted, fixed loopback application's own resource URLs. */
export function embedMagpie(html: string, prefix: string, csrf: string) {
  if(!/^\/[a-zA-Z0-9/_-]+$/.test(prefix))throw new Error('invalid Magpie deployment prefix');
  // 上游插件（plugins/library/i18n.js 等）会在核心脚本之前就调用 `magpie.plugin(...)`，
  // 之前是 ReferenceError、只补空对象又变成 TypeError。这里给一个「任何属性都返回可调用
  // 空壳」的占位：插件注册不报错，核心脚本加载后会自己覆盖成真正的 magpie。
  // 只影响面板渲染，不动 API、不动 CSRF、不动网关屏蔽。
  const bootstrap = `<base href="${prefix}/"><script>(()=>{if(!window.magpie){const noop=()=>stub();const stub=()=>new Proxy(function(){},{get:(t,k)=>(k===Symbol.toPrimitive?"":noop),apply:()=>stub(),construct:()=>stub()});window.magpie=stub()}const base=${scriptString(prefix)},csrf=${scriptString(csrf)};const rewrite=(s)=>{const u=new URL(s,location.href);return u.origin===location.origin&&!u.pathname.startsWith(base+'/')?base+u.pathname+u.search+u.hash:u.href};const original=window.fetch;window.fetch=(input,init={})=>{const r=input instanceof Request?input:null;const h=new Headers(init.headers||(r&&r.headers)||{});if(!['GET','HEAD'].includes((init.method||(r&&r.method)||'GET').toUpperCase()))h.set('x-csrf-token',csrf);return original(r?new Request(rewrite(r.url),r):rewrite(String(input)),{...init,headers:h})};const ES=window.EventSource;if(ES)window.EventSource=class extends ES{constructor(url,options){super(rewrite(String(url)),options)}};})();</script>`;
  const readiness = `<script>(()=>{const base=${scriptString(prefix)};let failed=false,sent=false;const send=(state)=>parent.postMessage({type:'geohot:magpie:'+state},location.origin);const check=()=>{if(!failed&&!sent&&document.getElementById('pageTitle')?.textContent?.trim()){sent=true;send('ready')}};const fix=(node)=>{if(!(node instanceof Element))return;for(const el of [node,...node.querySelectorAll('[src]')]){const src=el.getAttribute('src');if(src&&src.startsWith('/')&&!src.startsWith('//')&&!src.startsWith(base+'/'))el.setAttribute('src',base+src)}};new MutationObserver(records=>{for(const r of records){if(r.type==='attributes')fix(r.target);else for(const n of r.addedNodes)fix(n)}check()}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});addEventListener('load',()=>{fix(document.documentElement);check()},{once:true});addEventListener('error',e=>{if(e.target instanceof HTMLScriptElement){failed=true;send('failed')}},true);})();</script>`;
  return html.replace(/(src|href|action)=(['"])\/(?!\/)/g, `$1=$2${prefix}/`).replace(/<head([^>]*)>/i, `<head$1>${bootstrap}${readiness}`);
}

/**
 * 公网地址只从环境变量读：仓库是公开的，把这四台机器的 IP 写进源码等于白送一份拨号清单。
 * 形如 {"xxc":"203.0.113.9","hcss-ecs-6a39":"198.51.100.7"}，键是主机名前缀，值必须是字符串。
 */
export function nodeIps(raw = process.env.GEOHOT_NODE_IPS): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [prefix, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[prefix] = value.trim();
    }
    return out;
  } catch { return {}; }
}
/** 主机名前缀匹配：心跳里的 host 是平台给的机器名，前缀足够区分四台执行器。 */
export function ipFor(host: string, table: Record<string, string> = nodeIps()): string | null {
  for (const [prefix, ip] of Object.entries(table)) if (host.startsWith(prefix)) return ip;
  return null;
}

/** 纯函数：判断 Magpie 面板静态资源（根级 js/css + assets/plugins/fonts/icons 下 js/css/字体/图片）。 */
export function isMagpieStatic(suffix: string): boolean {
  return /^(?:[a-zA-Z0-9_-]+\.(?:js|css)|(?:assets|plugins|fonts|icons)\/[a-zA-Z0-9_./-]+\.(?:js|css|svg|png|ico|woff2?|ttf))$/.test(suffix);
}

export async function registerServerConsole(app: FastifyInstance, forward = magpieRequest, authenticate: typeof sessionPrincipal = sessionPrincipal) {
  const guard = (fn: Parameters<typeof adminHandler>[0]) => adminHandler(fn, authenticate);
  if (!app.hasDecorator('rateLimit')) await app.register(rateLimit, { global:true, max:600, timeWindow:'1 minute' });
  app.get("/api/admin/server", {config:{rateLimit:{max:30,timeWindow:'1 minute'}}}, guard(async (_req, reply) => {
    try {
      const text = await readFile(process.env.SERVER_STATUS_FILE || "/run/geohot-server/status.json", "utf8");
      if (text.length > 100_000) throw new Error("oversize sample");
      const sample = JSON.parse(text);
      // 协同节点：每台辅助机器（阿里云那两台、本机执行器）都在 settings 里写 heartbeat.<role>@<host>，
      // 带 host 与 updated_at。服务器面板直接读这张表，不必从主库 SSH 出去，也不必让辅助机暴露端口。
      // 键里必须带主机名：两台执行器的 role 都是 content-executor，只按 role 存会互相覆盖，
      // 面板上就永远只看得见最后心跳的那一台。
      const beats = await sql<{ key: string; value: Record<string, unknown>; updated_at: Date }[]>`
        SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`;
      const nodes = beats.map((row) => {
        const at = row.updated_at instanceof Date ? row.updated_at.getTime() : Date.parse(String(row.updated_at));
        return {
          role: row.key.slice("heartbeat.".length).split("@")[0],
          host: String(row.value?.host ?? "?"),
          // 地址由 API 从环境变量补上，页面不再自带一份。
          ip: ipFor(String(row.value?.host ?? "?")),
          // 地名 + 公网 IP 由机器自己报（GEOHOT_HEARTBEAT_LABEL），面板优先用它做标题。
          label: typeof row.value?.label === "string" ? row.value.label : null,
          release: String(row.value?.release ?? ""),
          slots: typeof row.value?.slots === "number" ? row.value.slots : null,
          // 远端机器一并把自己的负载/内存/磁盘报上来，面板就不用 SSH 出去取数。
          load: typeof row.value?.load === "number" ? row.value.load : null,
          loadAll: Array.isArray(row.value?.loadAll) ? row.value.loadAll : null,
          cpus: typeof row.value?.cpus === "number" ? row.value.cpus : null,
          cpuPercent: typeof row.value?.cpuPercent === "number" ? row.value.cpuPercent : null,
          memTotal: typeof row.value?.memTotal === "number" ? row.value.memTotal : null,
          memFree: typeof row.value?.memFree === "number" ? row.value.memFree : null,
          swapTotal: typeof row.value?.swapTotal === "number" ? row.value.swapTotal : null,
          swapFree: typeof row.value?.swapFree === "number" ? row.value.swapFree : null,
          diskFree: typeof row.value?.diskFree === "number" ? row.value.diskFree : null,
          diskTotal: typeof row.value?.diskTotal === "number" ? row.value.diskTotal : null,
          uptime: typeof row.value?.uptime === "number" ? row.value.uptime : null,
          platform: typeof row.value?.platform === "string" ? row.value.platform : null,
          kernel: typeof row.value?.kernel === "string" ? row.value.kernel : null,
          services: Array.isArray(row.value?.services) ? row.value.services : [],
          ports: Array.isArray(row.value?.ports) ? row.value.ports : [],
          at: Number.isFinite(at) ? new Date(at).toISOString() : null,
          alive: Number.isFinite(at) && Date.now() - at < 180_000,
        };
      });
      return { ...sample, ip: ipFor(String(sample.host ?? "")), stale: Date.now() - Date.parse(sample.checkedAt) > 90_000, nodes };
    } catch { return reply.code(503).send({ unavailable: true }); }
  }));
  // 静态资源（根级 kernel/start/app.js、theme.css + assets/plugins/fonts）不限流，靠浏览器 Cache-Control。
  // 注意：max:0 会被限流插件当成直接封锁（429），必须用 rateLimit:false 关闭；否则未认证的根路径
  // 会先撞限流返回 429，而不是经 guard 返回 401。
  // routePrefix 用于前缀通配路由：Fastify 只把前缀之后的片段放进 `*`，这里要拼回完整后缀，
  // 静态判定与上游转发都按完整路径进行。
  const buildHandler = (routePrefix?: string) => guard(async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, admin: { csrf: string }) => {
    const wildcard = (req.params as { "*": string })["*"];
    const file = (req.params as { file?: string }).file;
    const suffix = routePrefix ? `${routePrefix}/${wildcard ?? ""}` : (wildcard ?? file ?? "");
    // URL is never supplied by the caller; do not proxy the model gateway or token sign-in routes.
    const staticResource = isMagpieStatic(suffix);
    if (suffix && suffix !== "index.html" && !suffix.startsWith("api/") && !staticResource) return reply.code(404).send({ error: "not_found" });
    if (suffix.split('/').some(part => part === '.' || part === '..') || suffix.includes('\\')) return reply.code(400).send({ error: "invalid_path" });
    if (req.headers.origin && req.headers.origin !== new URL(config.siteUrl).origin) return reply.code(403).send({ error: "forbidden" });
    let secret: string;
    try { secret = await magpieCookie(); }
    catch { return reply.code(503).send({ error: "magpie_unavailable" }); }
    const base = magpieBase();
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const target = new URL(`/${suffix}${query}`, base);
    if (!isLoopbackHost(target.hostname) || target.searchParams.has("k") || target.pathname.startsWith('/v1') || target.pathname.startsWith('/_magpie')) return reply.code(400).send({ error: "invalid_path" });
    const headers: Record<string, string> = { cookie: `magpie_web_3430=${secret}`, "accept-encoding": "identity", origin: base.origin };
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
      // 2026-11-20：Magpie 的 app.js/i18n.js 每个可达 1–2MB，浏览器会并发拉多个；旧路径把
      // 每个响应完整 Buffer.concat 在 API 堆里，再加 128MiB heap 会直接触发生产 OOM（读者 API
      // 与后台共用进程）。静态白名单只来自 loopback、扩展名固定，直接流式转发，不再复制整块。
      // HTML 仍需 embedMagpie 注入 CSRF/基址；动态 API/HTML 保留 8MB 上限。
      if (staticResource && !contentType.includes("text/html")) {
        reply.code(upstream.status).type(contentType);
        if (!upstream.body || req.method === "HEAD") return reply.send();
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
  });
  // 静态资源（根级 kernel/start/app.js、theme.css + assets/plugins/fonts）不限流，靠浏览器 Cache-Control。
  // 注意：max:0 会被限流插件当成直接封锁（429），必须用 rateLimit:false 关闭；否则未认证的根路径
  // 会先撞限流返回 429，而不是经 guard 返回 401。
  const staticOpts = (handler: import("fastify").RouteHandler) => ({ config: { rateLimit: false } as const, handler });
  app.route({ method: ["GET", "HEAD"], url: "/api/admin/magpie-proxy/:file", ...staticOpts(buildHandler()) });
  for (const prefix of ["assets", "plugins", "fonts", "icons"]) {
    app.route({ method: ["GET", "HEAD"], url: `/api/admin/magpie-proxy/${prefix}/*`, ...staticOpts(buildHandler(prefix)) });
  }
  // 动态 API 面板调用保持有界上限（静态资源走独立缓存、不限流）。
  app.route({ method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], url: "/api/admin/magpie-proxy/*", config:{rateLimit:{max:1200,timeWindow:'1 minute'}}, handler: buildHandler() });
}
