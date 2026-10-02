// Production web server: built client assets, the shared redirect table and SSR. Api-owned paths are
// proxied to the api process, so one port serves the whole site; a reverse proxy in front may also send
// them to the api directly.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestListener } from "@react-router/node";
import { deployBase, isApiOwned, resolveRedirect, toAppPath, toPublicPath } from "@aihot/contracts/http-policy";

const PORT = Number(process.env.WEB_PORT || process.env.PORT || 3000);
const HOST = process.env.WEB_HOST || "127.0.0.1";
const API = new URL(process.env.API_BASE_URL || "http://127.0.0.1:3001");
/**
 * Whether a reverse proxy in front (Caddy, nginx) records the visitor in X-Forwarded-For. Without one
 * the header is never believed: a visitor could name any address and slip past the api's per-visitor
 * limits (sign-in attempts, feedback).
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const CLIENT_DIR = path.resolve(import.meta.dirname, "build/client");
/** Browsers keep a page at most this long, so a withdrawal reaches them within minutes. */
const BROWSER_MAX_SECONDS = 300;

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const build = await import(pathToFileURL(path.resolve(import.meta.dirname, "build/server/index.js")).href);
const ssr = createRequestListener({ build, mode: "production" });

/**
 * The path this deployment answers on (`/geohot`), taken from the build so it can never disagree with the
 * client bundle or with `basename`. Empty at the domain root, where every call below returns its argument.
 */
const BASE = (() => {
  const basename = String(build.basename ?? "/");
  return basename === "/" ? "" : basename.replace(/\/+$/, "");
})();
const siteBase = deployBase(process.env.SITE_URL);
if (siteBase !== BASE) {
  console.warn(JSON.stringify({ level: "warn", msg: "SITE_URL path and the built basename disagree", basename: BASE || "/", siteUrl: process.env.SITE_URL ?? "" }));
}

class BadRequest extends Error {}

/** Hashed build assets are immutable; anything else from the client build gets a short cache. */
async function serveStatic(pathname: string, res: import("node:http").ServerResponse): Promise<boolean> {
  if (pathname.includes("..") || pathname.endsWith("/")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new BadRequest("malformed percent-encoding");
  }
  const file = path.join(CLIENT_DIR, decoded);
  if (!file.startsWith(CLIENT_DIR)) return false;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  const immutable = pathname.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

// One bad request must never take the process down: answer it and keep serving.
const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    const bad = error instanceof BadRequest || error instanceof URIError;
    if (!bad) console.error(JSON.stringify({ level: "error", msg: "web request failed", path: (req.url ?? "").split("?")[0]!.slice(0, 200), error: String(error).slice(0, 500) }));
    if (res.headersSent) return res.destroy();
    res.writeHead(bad ? 400 : 500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(bad ? "Bad request" : "Internal error");
  });
});

/** Public navigation returns all matched loaders, so `_routes` never changes a cached answer. */
function pageCache(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, appPath: string) {
  const url = new URL(req.url ?? "/", "http://web.local");
  const pathname = decodeURIComponent(appPath).replace(/\.data$/, "");
  const publicRead = (req.method === "GET" || req.method === "HEAD") && !/^\/admin(?:\/|$)/i.test(pathname);
  if (publicRead && url.pathname.endsWith(".data")) {
    url.searchParams.delete("_routes");
    req.url = url.pathname + url.search;
  }

  // React Router uses the same route headers for HTML and single-fetch data. Apply the final
  // status here: a route's successful cache policy must never cache its error or action result.
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, messageOrHeaders?: string | import("node:http").OutgoingHttpHeaders, headers?: import("node:http").OutgoingHttpHeaders) => {
    const outgoing = typeof messageOrHeaders === "string" ? headers : messageOrHeaders;
    for (const [name, value] of Object.entries(outgoing ?? {})) if (value !== undefined) res.setHeader(name, value);
    const cc = String(res.getHeader("Cache-Control") ?? "");
    if (!publicRead || status !== 200 || res.hasHeader("Set-Cookie") || !cc || /(?:private|no-store)/i.test(cc)) {
      res.removeHeader("Expires");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Accel-Expires", "0");
    } else {
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const sharedSeconds = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/i)?.[1] ?? 0);
      const expires = String(res.getHeader("X-Accel-Expires") ?? `@${nowSeconds + sharedSeconds}`);
      // A sibling loader may have delayed this response after the selected loader set its TTL.
      const seconds = /(?:^|,)\s*no-cache(?:,|$)/i.test(cc) || expires === "0" ? 0
        : Math.max(0, Math.min(sharedSeconds, Number(expires.slice(1)) - nowSeconds));
      res.setHeader("Date", now.toUTCString());
      res.setHeader("X-Accel-Expires", seconds > 0 ? expires : "0");
      // Reuse intent-prefetched data in the browser within the same shared-cache deadline (capped).
      // Never serve it beyond that deadline, including while revalidating or on an error.
      const directives = cc.split(",").map((value) => value.trim()).filter((value) => !/^(?:max-age|s-maxage|stale-while-revalidate|stale-if-error|must-revalidate)(?:=|$)/i.test(value));
      res.setHeader("Cache-Control", seconds > 0
        ? `${directives.join(", ")}, max-age=${Math.min(seconds, BROWSER_MAX_SECONDS)}, s-maxage=${seconds}, must-revalidate`
        : "no-cache");
    }
    return typeof messageOrHeaders === "string" ? writeHead(status, messageOrHeaders) : writeHead(status);
  }) as typeof res.writeHead;
}

async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const raw = req.url ?? "/";
  const qi = raw.indexOf("?");
  const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
  const search = qi >= 0 ? raw.slice(qi) : "";
  // Whether or not the proxy in front stripped the prefix, the path tables, the client build and the api
  // are all written for the root, and React Router is handed the prefixed path its basename matches.
  const appPath = toAppPath(pathname, BASE);
  if (BASE) req.url = toPublicPath(appPath, BASE) + search;

  const decision = resolveRedirect(appPath, search);
  if (decision) {
    for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
    // The tables are written for the root; the browser needs the prefix back (React Router already adds
    // it to its own redirects, and the api's are rewritten below, so nginx needs no `proxy_redirect`).
    if (decision.location) res.setHeader("Location", toPublicPath(decision.location, BASE));
    res.statusCode = decision.status;
    return res.end(decision.location ? undefined : decision.status === 410 ? "Gone" : "Not found");
  }

  if (isApiOwned(appPath)) {
    // The visitor's address, decided here: the one the trusted proxy saw (the last X-Forwarded-For
    // entry), or this connection's own. Both headers carry only that.
    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    const client = TRUST_PROXY && forwarded.length ? forwarded[forwarded.length - 1]! : (req.socket.remoteAddress ?? "");
    const headers = { ...req.headers, "x-forwarded-for": client, "x-real-ip": client };
    const upstream = httpRequest({ hostname: API.hostname, port: API.port, path: appPath + search, method: req.method, headers }, (up) => {
      // The api knows nothing about the prefix, so its root-relative redirects get it here.
      const headers = { ...up.headers };
      if (BASE && typeof headers.location === "string") headers.location = toPublicPath(headers.location, BASE);
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      // The api can reset the socket after the response has started; ending it again would throw inside
      // the listener, where neither handle()'s catch nor the rejection hook can reach it.
      if (res.headersSent) return res.destroy();
      res.statusCode = 502;
      res.end("api unavailable");
    });
    return req.pipe(upstream);
  }

  if ((req.method === "GET" || req.method === "HEAD") && appPath.includes(".") && (await serveStatic(appPath, res))) return;
  pageCache(req, res, appPath);
  return ssr(req, res);
}

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", msg: "unhandled rejection", error: String(reason).slice(0, 500) }));
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => console.log(JSON.stringify({ level: "info", msg: "web started", port: (server.address() as import("node:net").AddressInfo).port, pid: process.pid })));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
