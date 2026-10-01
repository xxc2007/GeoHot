import type { Config } from "@react-router/dev/config";

/**
 * The path the site is served on (`BASE_PATH=/geohot` behind a prefixing proxy). Unset or `/` leaves the
 * build with React Router's own default, so a site at the domain root is unchanged.
 */
const BASENAME = (() => {
  const raw = (process.env.BASE_PATH ?? "").trim();
  if (!raw || raw === "/") return "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.replace(/\/+$/, "");
})();

export default {
  ssr: true,
  appDirectory: "app",
  buildDirectory: "build",
  basename: BASENAME,
  // The whole route manifest ships with the page: no /__manifest?paths=… requests, whose answers are
  // cacheable for a year while a CDN's page cache would not key them on paths or version.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
