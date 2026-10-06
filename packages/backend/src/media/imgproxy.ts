// Signed image proxy URLs. The address format and signing key stay stable, so proxy URLs
// already cached in full RSS and readers keep working: /api/img-proxy?u=&mode=&exp=&sig=
// sig = hex(HMAC-SHA256(IMG_PROXY_SIGN_SECRET, 每段带长度的 `u|mode|exp`))，按请求发出前 16 个十六进制
// 位（64 位）：随机位压不动，而完整长度曾占压缩后列表页的约十分之一。旧 URL 的全长签名仍然收，
// 逐字段带长度之前的那种拼法也仍然验得过（见 `signedMessage`）。
import { createHmac, timingSafeEqual } from "node:crypto";
import { deployBase } from "@aihot/contracts/http-policy";
import { config, credential } from "../config.ts";

import { IMAGE_WIDTHS, RESPONSIVE_MODES, type ProxyMode, type ResponsiveImageKind } from "./renditions.ts";
export type { ProxyMode } from "./renditions.ts";

/**
 * What a relative proxy URL is relative to: a site served under `SITE_URL=https://xxc2007.me/geohot`
 * needs the browser to ask `/geohot/api/img-proxy`, because the proxy in front strips it again. A site at
 * the domain root gets "", so these URLs stay exactly as they were.
 */
const SITE_BASE = deployBase(config.siteUrl);

// A URL keeps its expiry for a whole day, so the edge and browsers can reuse one copy of an image all
// day; it stays valid for two to three days.
const WINDOW_SECONDS = 24 * 3600;
const LIFETIME_SECONDS = 48 * 3600;
const SIG_HEX = 16;

function secret(): string {
  const s = credential("auth", "IMG_PROXY_SIGN_SECRET");
  if (!s) throw new Error("IMG_PROXY_SIGN_SECRET is not configured");
  return s;
}

/**
 * The signed message. It used to be the bare concatenation `${url}|${mode}|${exp}`, and a `|` is legal in
 * a URL path: one legitimate signature then re-splits into a *different* (url, mode) pair over the same
 * bytes, and a mode nobody minted falls through to the full 1600 px rendition (`images.ts` looks the
 * width up by name). Length-prefixing each field makes the boundary unambiguous.
 *
 * The old form is still accepted when *verifying*, because RSS readers and the edge cache hold URLs signed
 * with it for days — that is the reason the address format is frozen. Nothing mints new ones.
 */
const signedMessage = (url: string, mode: string, exp: number | string) => `${url.length}:${url}|${mode.length}:${mode}|${exp}`;
const legacyMessage = (url: string, mode: string, exp: number | string) => `${url}|${mode}|${exp}`;
const hmacHex = (message: string) => createHmac("sha256", secret()).update(message).digest("hex");

export function signature(url: string, mode: string, exp: number | string): string {
  return hmacHex(signedMessage(url, mode, exp));
}

/** Expiry rounded up to a day boundary at least `lifetime` (48 h) ahead, so URLs stay cacheable. */
export function proxyExpiry(nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): number {
  return Math.ceil((nowMs / 1000 + lifetimeSeconds) / WINDOW_SECONDS) * WINDOW_SECONDS;
}

export function proxiedImage(url: string | null | undefined, mode: ProxyMode, absolute = false, nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): string | null {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  const exp = proxyExpiry(nowMs, lifetimeSeconds);
  const path = `/api/img-proxy?u=${encodeURIComponent(url)}&mode=${mode}&exp=${exp}&sig=${signature(url, mode, exp).slice(0, SIG_HEX)}`;
  return absolute ? `${config.siteUrl}${path}` : `${SITE_BASE}${path}`;
}

/** Browser source candidates, each independently signed with the same expiry boundary. */
export function proxiedImageSet(url: string | null | undefined, kind: ResponsiveImageKind, absolute = false, nowMs = Date.now(), lifetimeSeconds = LIFETIME_SECONDS): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return RESPONSIVE_MODES[kind].map((mode) => `${proxiedImage(url, mode, absolute, nowMs, lifetimeSeconds)} ${IMAGE_WIDTHS[mode]}w`).join(", ");
}

export type VerifyResult = { ok: true; url: string; mode: string } | { ok: false; reason: "missing" | "expired" | "bad-signature" | "bad-url" | "bad-mode" };

export function verifyProxyRequest(params: { u?: string; mode?: string; exp?: string; sig?: string }, nowMs = Date.now()): VerifyResult {
  const { u, mode, exp, sig } = params;
  if (!u || mode === "" || !exp || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{9,11}$/.test(exp)) return { ok: false, reason: "missing" };
  if (Number(exp) * 1000 < nowMs) return { ok: false, reason: "expired" };
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: "bad-url" };
  // Legacy article pages signed body images without a mode (as "default"); those still in open tabs and
  // caches keep loading, as full images, until their signature expires.
  const given = Buffer.from(new RegExp(`^(?:[0-9a-f]{${SIG_HEX}}|[0-9a-f]{64})$`, "i").test(sig) ? sig : "", "hex");
  // Canonical form first, then the pre-2026-10-05 concatenation: URLs already sitting in RSS readers and
  // in the edge cache were signed with it, and refusing them would break reader-visible images for days.
  const signed = signedMessage(u, mode ?? "default", exp);
  const verified = [signed, legacyMessage(u, mode ?? "default", exp)].some((message) => {
    const expected = Buffer.from(hmacHex(message), "hex").subarray(0, given.length);
    return expected.length === given.length && timingSafeEqual(given, expected);
  });
  if (given.length === 0 || !verified) return { ok: false, reason: "bad-signature" };
  // A mode we never minted is not a request we serve: the width lookup falls back to 1600 px, so an
  // unvalidated mode is a way to ask for the biggest rendition of a URL signed for a small one.
  // `hasOwn`, not `in`: an inherited name like `toString` is `in` the table and would reach sharp as a width.
  // ("default" is the legacy no-mode spelling still cached from old article pages.)
  if (mode !== undefined && mode !== "default" && !Object.hasOwn(IMAGE_WIDTHS, mode)) return { ok: false, reason: "bad-mode" };
  return { ok: true, url: u, mode: mode ?? "full" };
}

/**
 * Rewrites <img>/<video poster> sources in whitelisted body HTML to signed proxy URLs. Feed readers keep
 * items for days, so full RSS asks for a longer signature than a page.
 */
export function proxyBodyImages(html: string, absolute = false, lifetimeSeconds = LIFETIME_SECONDS): string {
  const now = Date.now();
  return html
    .replace(/<img\b([^>]*)>/gi, (tag: string, attrs: string) => {
      const src = attrs.match(/\ssrc="([^"]+)"/i);
      if (!src) return tag;
      const decoded = src[1]!.replace(/&amp;/g, "&");
      const proxied = proxiedImage(decoded, "full", absolute, now, lifetimeSeconds);
      // Width descriptors change an image's natural CSS size. Only use them for a body image with
      // an explicit display width: unknown and small pictures must retain their intrinsic size.
      // RSS keeps its existing single signed full image.
      const width = Number(attrs.match(/\bwidth="(\d+)"/i)?.[1] ?? 0);
      const candidates = !absolute && width >= IMAGE_WIDTHS["image-720"] ? proxiedImageSet(decoded, "body", false, now, lifetimeSeconds) : null;
      // `sizes=auto` adds size containment in Chrome: stale publisher width/height metadata then
      // overrides the loaded image's real ratio and squashes the picture (upstream 3e36e48). Let the
      // intrinsic dimensions win after loading.
      const responsive = candidates ? ` srcset="${candidates.replace(/&/g, "&amp;")}" sizes="(min-width: 1536px) 760px, (min-width: 1024px) calc(100vw - 524px), (min-width: 640px) 608px, calc(100vw - 32px)"` : "";
      const source = proxied ? ` src="${proxied.replace(/&/g, "&amp;")}"${responsive} loading="lazy" decoding="async"` : "";
      return `<img${attrs.replace(src[0], source)}>`;
    })
    .replace(/<video\b([^>]*?)\sposter="([^"]+)"/gi, (_m, pre: string, src: string) => {
      const proxied = proxiedImage(src.replace(/&amp;/g, "&"), "thumb", absolute, now, lifetimeSeconds);
      return proxied ? `<video${pre} poster="${proxied.replace(/&/g, "&amp;")}"` : `<video${pre}`;
    });
}
