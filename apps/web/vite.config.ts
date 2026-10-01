import { request as httpRequest } from "node:http";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { isApiOwned, resolveRedirect, toAppPath, toPublicPath } from "@aihot/contracts/http-policy";

const API = new URL(process.env.API_BASE_URL || "http://127.0.0.1:3001");
/**
 * The path this build is served on (`BASE_PATH=/geohot`), normalised the way Vite wants it. Unset or `/`
 * keeps the default, so a site that owns the domain root builds exactly what it built before.
 */
const BASE = (() => {
  const raw = (process.env.BASE_PATH ?? "").trim();
  if (!raw || raw === "/") return "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.endsWith("/") ? path : `${path}/`;
})();
const DEPLOY_BASE = BASE === "/" ? "" : BASE.replace(/\/+$/, "");

/** Development stand-in for the production web server: the shared redirect table and api-owned path routing. */
function devEdge(): Plugin {
  return {
    name: "aihot-dev-edge",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? "/";
        const qi = raw.indexOf("?");
        const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
        const search = qi >= 0 ? raw.slice(qi) : "";
        // The tables below are root-anchored: a proxy that keeps the prefix is answered as if it stripped.
        const appPath = toAppPath(pathname, DEPLOY_BASE);
        if (appPath.startsWith("/@") || appPath.startsWith("/node_modules/") || appPath.startsWith("/app/") || appPath.startsWith("/__")) {
          if (DEPLOY_BASE) req.url = appPath + search;
          return next();
        }
        // React Router matches against the basename, so it always sees the prefixed path.
        if (DEPLOY_BASE) req.url = toPublicPath(appPath, DEPLOY_BASE) + search;
        const decision = resolveRedirect(appPath, search);
        if (decision) {
          for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
          // Locations are written for the root; the browser needs the prefix back.
          if (decision.location) res.setHeader("Location", toPublicPath(decision.location, DEPLOY_BASE));
          res.statusCode = decision.status;
          return res.end();
        }
        if (!isApiOwned(appPath)) return next();
        const upstream = httpRequest(
          { hostname: API.hostname, port: API.port, path: appPath + search, method: req.method, headers: req.headers },
          (up) => {
            const out = { ...up.headers };
            if (DEPLOY_BASE && typeof out.location === "string") out.location = toPublicPath(out.location, DEPLOY_BASE);
            res.writeHead(up.statusCode ?? 502, out);
            up.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.statusCode = 502;
          res.end("api unavailable");
        });
        req.pipe(upstream);
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [devEdge(), tailwindcss(), reactRouter()],
  server: { port: 3000, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        // A page used to load 15–30 small shared chunks (a third of all edge requests were JS files).
        // Framework code stays one stable chunk across releases; app code that at least four public
        // routes share is one chunk (7–10 files a page, and less JavaScript than before on every page
        // but the three smallest, measured 2026-09-29); the rest keeps automatic splitting. Motion is
        // left to the admin pages.
        codeSplitting: {
          groups: [
            { name: "framework", test: /node_modules[\\/](?:react|react-dom|scheduler|react-router|@react-router|cookie|set-cookie-parser|turbo-stream)[\\/]/, priority: 30 },
            { name: "motion", test: /node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils)[\\/]/, priority: 20 },
            { name: "shared", test: /apps[\\/]web[\\/]app[\\/](?!features[\\/]admin[\\/]|routes[\\/])/, minShareCount: 4, priority: 10 },
          ],
        },
      },
    },
  },
});
