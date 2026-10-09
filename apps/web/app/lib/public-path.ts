// One place that knows which path the site answers on. A deployment behind a prefixing proxy
// (`https://xxc2007.me/geohot`) sets BASE_PATH at build time; Vite writes it into `base`, which arrives
// here as import.meta.env.BASE_URL. Every root-absolute URL the browser emits itself — fetch() calls,
// plain <a href>, <img src> — goes through publicPath(). With no BASE_PATH the base is empty and every
// call returns its argument unchanged, so a site that owns the domain root behaves exactly as before.
import { toAppPath, toPublicPath } from "@aihot/contracts/http-policy";

/** `/geohot` behind a prefix, `""` at the domain root. */
export const basePath = (() => {
  // Typed locally rather than via `vite/client`'s ambient `ImportMetaEnv`: this module is also loaded by
  // the root test suite (through `lib/back-place.ts`), where there is no Vite and no Vite tsconfig.
  // A Vite build replaces `import.meta.env` with a literal object, so the value it bakes in is unchanged.
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL || "/";
  return base === "/" ? "" : base.replace(/\/+$/, "");
})();

/** An app-root path (`/api/site/timeline`, `/feed.xml`) as the browser must see it. */
export function publicPath(path: string): string {
  return toPublicPath(path, basePath);
}

/** A browser path back to the app root, for a value the api echoes as its own redirect (`?return=`). */
export function appPath(path: string): string {
  return toAppPath(path, basePath);
}
