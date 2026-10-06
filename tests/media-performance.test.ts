import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const dir = await mkdtemp(path.join(tmpdir(), "aihot-media-test-"));
process.env.AIHOT_DATA_DIR = dir;
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
process.env.MODEL_CALLS_ENABLED = "false";
const { guardedFetch } = await import("@aihot/backend/lib/http-fetch");
const { produceImage } = await import("@aihot/backend/media/images");
const { renderOg } = await import("../apps/api/src/og/render.ts");
const { renderPoster } = await import("../apps/api/src/og/poster.ts");
const { xView, videoMedia } = await import("@aihot/backend/publication/items");

let imageHits = 0;
let failureHits = 0;
const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#176b75" } }).png().toBuffer();
// Ten noisy 160×120 frames: a GIF that animated WebP clearly beats.
const frames = await sharp({ create: { width: 160, height: 1200, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).raw().toBuffer();
const animatedGif = await sharp(frames, { raw: { width: 160, height: 1200, channels: 3, pageHeight: 120 } }).gif({ loop: 0, delay: Array(10).fill(90) }).toBuffer();
const staticGif = await sharp({ create: { width: 1200, height: 900, channels: 4, background: { r: 23, g: 107, b: 117, alpha: 0.6 } } }).gif().toBuffer();
const server = createServer(async (req, res) => {
  if (req.url === "/anim.gif") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(animatedGif); }
  if (req.url === "/static.gif") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(staticGif); }
  if (req.url?.startsWith("/redirect/")) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    res.writeHead(302, { location: `/redirect/${Number(req.url.split("/").pop()) + 1}` });
    return res.end();
  }
  if (req.url === "/fail") { failureHits++; res.writeHead(502); return res.end(); }
  imageHits++;
  await new Promise((resolve) => setTimeout(resolve, 60));
  res.writeHead(200, { "content-type": "image/png" });
  res.end(png);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import("@aihot/backend/db");
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

test("one timeout covers the complete redirect chain", async () => {
  await assert.rejects(guardedFetch(`${base}/redirect/0`, { timeoutMs: 140 }), { name: "TimeoutError" });
});

test("simultaneous modes share original bytes, preserve dimensions and use their disk caches", async () => {
  const [thumb, full, avatar, card] = await Promise.all([produceImage(`${base}/image`, "thumb"), produceImage(`${base}/image`, "full"), produceImage(`${base}/image`, "avatar"), produceImage(`${base}/image`, "card")]);
  assert.equal(imageHits, 1);
  assert.deepEqual(await Promise.all([thumb, full, avatar, card].map(async (image) => (await sharp(image.body).metadata()).width)), [720, 800, 96, 336]);
  assert.deepEqual(await produceImage(`${base}/image`, "thumb"), thumb);
  assert.equal(imageHits, 1);
});

test("failed originals are not retried for every mode", async () => {
  await assert.rejects(produceImage(`${base}/fail`, "thumb"));
  await assert.rejects(produceImage(`${base}/fail`, "full"));
  assert.equal(failureHits, 1);
});

test("site media exposes responsive previews and full lightboxes while RSS retains thumb images", () => {
  const row = { zh_text: null, x_post: { media: [{ url: "https://example.org/1.png" }, { url: "https://example.org/2.png", poster: "https://example.org/poster.png" }] } };
  assert.ok(xView(row, true)!.media.every((m) => m.url.includes("mode=card") && m.fullUrl?.includes("mode=full")));
  assert.ok(xView(row, true)!.media[1]!.poster!.includes("mode=card"));
  assert.ok(xView(row)!.media.every((m) => m.url.includes("mode=thumb") && m.fullUrl === undefined));
  assert.ok(xView(row, false, true)!.media.every((m) => m.url.includes("mode=full") && m.srcSet?.includes("mode=image-720")));
  row.x_post.media[1]!.url = "javascript:invalid";
  const single = xView(row, true)!.media;
  assert.equal(single.length, 1);
  assert.ok(single[0]!.url.includes("mode=thumb"));
});

test("concurrent cold OG and poster requests all succeed with identical cached bytes", async () => {
  const card = { kicker: "GEOHOT", title: "并发渲染验证", subtitle: "同一图片只生成一次" };
  const cards = await Promise.all(Array.from({ length: 6 }, () => renderOg(card)));
  for (const result of cards) assert.deepEqual(result, cards[0]);
  assert.equal((await sharp(cards[0]!.png).metadata()).width, 1200);
  const poster = { url: "https://example.com/items/test", kicker: "测试", title: "海报并发验证", summary: null, source: "测试来源", date: "2026-09-28", score: null };
  const posters = await Promise.all(Array.from({ length: 4 }, () => renderPoster(poster)));
  for (const result of posters) assert.deepEqual(result, posters[0]);
  assert.equal((await sharp(posters[0]!.png).metadata()).width, 1080);
});

test("successive responsive candidates reuse the completed original download", async () => {
  const before = imageHits;
  const url = `${base}/successive`;
  const small = await produceImage(url, "image-336");
  const large = await produceImage(url, "image-1200");
  const avatar = await produceImage(url, "avatar-48");
  assert.equal(imageHits - before, 1);
  assert.deepEqual(await Promise.all([small, large, avatar].map(async (image) => (await sharp(image.body).metadata()).width)), [336, 800, 48]);
});

test("the original cache expires and evicts old entries instead of retaining every source", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const before = imageHits;
  const url = `${base}/expires`;
  await produceImage(url, "image-336");
  t.mock.timers.tick(60_001);
  await produceImage(url, "image-720");
  assert.equal(imageHits - before, 2);
  for (let i = 0; i < 33; i++) await produceImage(`${base}/bounded-${i}`, "image-336");
  const count = imageHits;
  await produceImage(`${base}/bounded-0`, "image-720");
  assert.equal(imageHits, count + 1);
});

test("modern raster output preserves transparency and never flattens animation", async () => {
  const { resizeImage } = await import("@aihot/backend/media/images");
  const translucent = await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 10, g: 80, b: 160, alpha: 0.25 } } }).png().toBuffer();
  const rendered = await resizeImage(translucent, "image/png", "image-720");
  assert.equal(rendered.type, "image/webp");
  const meta = await sharp(rendered.body).metadata();
  assert.equal(meta.width, 32);
  assert.equal(meta.height, 24);
  assert.equal(meta.hasAlpha, true);
  const originalAlpha = await sharp(translucent).extractChannel("alpha").raw().toBuffer();
  assert.deepEqual(await sharp(rendered.body).extractChannel("alpha").raw().toBuffer(), originalAlpha);
  const pixels = Buffer.from([...Array(4).fill([255, 0, 0, 255]).flat(), ...Array(4).fill([0, 0, 255, 128]).flat()]);
  const gif = await sharp(pixels, { raw: { width: 2, height: 4, pageHeight: 2, channels: 4 } }).gif({ loop: 2, delay: [80, 160] }).toBuffer();
  assert.equal((await sharp(gif).metadata()).pages, 2);
  const animation = await resizeImage(gif, "image/gif", "image-336");
  assert.equal(animation.type, "image/gif");
  assert.deepEqual(animation.body, gif);
  const animatedWebp = await sharp(gif, { animated: true }).webp().toBuffer();
  assert.deepEqual((await resizeImage(animatedWebp, "image/webp", "image-336")).body, animatedWebp);
});

test("small SVG stays vector while a large vector receives the requested browser rendition", async () => {
  const { resizeImage } = await import("@aihot/backend/media/images");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"><rect width="1200" height="600" fill="#176b75"/></svg>';
  const vector = await resizeImage(Buffer.from(svg), "image/svg+xml", "image-720");
  assert.equal(vector.type, "image/svg+xml");
  const large = Buffer.from(svg.replace("</svg>", `<!--${"padding".repeat(20_000)}--></svg>`));
  const raster = await resizeImage(large, "image/svg+xml", "image-720");
  assert.equal(raster.type, "image/webp");
  assert.equal((await sharp(raster.body).metadata()).width, 720);
});

test("responsive URLs and web body candidates retain exact signatures and stable expiry", async () => {
  const { proxiedImageSet, proxyBodyImages, verifyProxyRequest } = await import("@aihot/backend/media/imgproxy");
  const now = Date.parse("2026-09-28T08:00:00Z");
  const candidates = proxiedImageSet("https://example.org/image.png", "card", false, now)!;
  assert.equal(candidates, proxiedImageSet("https://example.org/image.png", "card", false, now + 1000));
  for (const candidate of candidates.split(", ")) {
    const [value, width] = candidate.split(" ");
    const u = new URL(value!, "http://localhost");
    assert.deepEqual([...u.searchParams.keys()].sort(), ["exp", "mode", "sig", "u"]);
    const query = Object.fromEntries(u.searchParams);
    assert.equal(verifyProxyRequest(query, now).ok, true);
    assert.equal(width, query.mode === "image-336" ? "336w" : "720w");
    assert.equal(verifyProxyRequest({ ...query, mode: "image-1600" }, now).ok, false);
  }
  const html = '<p><img src="https://example.org/image.png?a=1&amp;b=2" width="800" height="400"></p>';
  assert.ok(!proxyBodyImages('<img src="https://example.org/small.png" width="160" height="80">').includes('srcset='));
  assert.ok(!proxyBodyImages('<img src="https://example.org/unknown.png">').includes('srcset='));
  const web = proxyBodyImages(html);
  assert.match(web, /srcset="[^"]+image-720/);
  assert.match(web, /loading="lazy"/);
  assert.match(web, /width="800" height="400"/);
  assert.doesNotMatch(proxyBodyImages(html, true), /srcset=/);
});

test("one signature serves one (url, mode) pair, and URLs signed before the fix still load", async () => {
  const { verifyProxyRequest, signature, proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const { createHmac } = await import("node:crypto");
  const now = Date.parse("2026-09-28T08:00:00Z");
  const exp = String(Math.ceil(now / 1000) + 3600);
  const hex = (message: string) => createHmac("sha256", process.env.IMG_PROXY_SIGN_SECRET!).update(message).digest("hex");
  // A `|` is legal in a URL path, so the old bare `url|mode|exp` concatenation is the same bytes as
  // (url="https://example.org/a", mode="thumb.png|image-336", exp) — a mode that was never minted and
  // that the width lookup would read as the biggest rendition.
  const url = "https://example.org/a|thumb.png";
  const signed = signature(url, "image-336", exp);
  const verdict = (q: { u?: string; mode?: string; exp?: string; sig?: string }) => {
    const v = verifyProxyRequest(q, now);
    return v.ok ? "ok" : v.reason;
  };
  assert.deepEqual(verifyProxyRequest({ u: url, mode: "image-336", exp, sig: signed }, now), { ok: true, url, mode: "image-336" });
  assert.equal(verdict({ u: "https://example.org/a", mode: "thumb.png|image-336", exp, sig: hex(`${url}|image-336|${exp}`).slice(0, 16) }), "bad-mode");
  // Moving any other field out of the message fails on the signature, before the mode question.
  assert.equal(verdict({ u: url, mode: "full", exp, sig: signed }), "bad-signature");
  assert.equal(verdict({ u: url, mode: "image-336", exp: String(Number(exp) - 3600), sig: signed }), "bad-signature");
  // RSS readers and the edge cache hold URLs minted with the old concatenation for days.
  assert.equal(verdict({ u: url, mode: "image-336", exp, sig: hex(`${url}|image-336|${exp}`).slice(0, 16) }), "ok");
  // Nothing mints them any more, and a mode outside the rendition table is refused.
  const fresh = new URL(proxiedImage(url, "image-336", false, now)!, "http://localhost");
  assert.equal(verdict(Object.fromEntries(fresh.searchParams)), "ok");
  assert.notEqual(fresh.searchParams.get("sig"), hex(`${url}|image-336|${exp}`).slice(0, 16));
  assert.equal(verdict({ u: url, mode: "image-48", exp, sig: hex(`${url}|image-48|${exp}`) }), "bad-mode");
  // `in` would let an inherited name through the table check and hand sharp a function as a width.
  assert.equal(verdict({ u: url, mode: "toString", exp, sig: hex(`${url}|toString|${exp}`) }), "bad-mode");
});

test("image HTTP responses keep issued URLs valid, reject tampering before fetching and do not vary on Accept", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/http-image`;
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const params = new URLSearchParams({ u: url, mode: "image-336", exp, sig: signature(url, "image-336", exp) });
  const before = imageHits;
  const invalidParams = new URLSearchParams(params);
  invalidParams.set("sig", "invalid");
  const invalid = await app.inject({ url: `/api/img-proxy?${invalidParams}` });
  assert.equal(invalid.statusCode, 403);
  assert.equal(imageHits, before);
  // A request that cannot be honoured at all is the caller's mistake (400, and 401 to an nginx auth
  // sub-request), not a refusal; a bad or expired signature stays 403.
  assert.equal((await app.inject({ url: "/api/img-proxy" })).statusCode, 400, "缺参数");
  assert.equal((await app.inject({ method: "HEAD", url: "/api/img-proxy", headers: { "x-aihot-img-proxy-auth": "1" } })).statusCode, 401, "鉴权子请求里的畸形查询");
  const bogusMode = new URLSearchParams({ u: url, mode: "image-99999", exp, sig: signature(url, "image-99999", exp) });
  assert.equal((await app.inject({ url: `/api/img-proxy?${bogusMode}` })).statusCode, 400, "没人签发过的 mode 也不该去取上游");
  assert.equal(imageHits, before, "三种畸形与被拒的请求都没有出网");
  const first = await app.inject({ url: `/api/img-proxy?${params}`, headers: { accept: "image/avif" } });
  const second = await app.inject({ url: `/api/img-proxy?${params}`, headers: { accept: "image/webp" } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["content-type"], "image/webp");
  assert.deepEqual(first.rawPayload, second.rawPayload);
  const old = new URLSearchParams({ u: url, exp, sig: signature(url, "default", exp) });
  assert.equal((await app.inject({ url: `/api/img-proxy?${old}` })).statusCode, 200);
  // Current URLs carry the first 16 hex digits; a wrong short signature is refused like a long one.
  const { proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const short = proxiedImage(url, "image-336")!;
  assert.match(short, /&sig=[0-9a-f]{16}$/);
  assert.equal((await app.inject({ url: short })).statusCode, 200);
  assert.equal((await app.inject({ url: short.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`) })).statusCode, 403);
  await app.close();
});

test("background preparation turns a cached GIF into a smaller animated WebP with every frame and its timing", async () => {
  const { convertAnimated } = await import("@aihot/backend/media/images");
  const passed = await produceImage(`${base}/anim.gif`, "image-336");
  assert.equal(passed.type, "image/gif");
  const saved = await convertAnimated(`${base}/anim.gif`, "image-336");
  assert.ok(saved > 0);
  const served = await produceImage(`${base}/anim.gif`, "image-336");
  assert.equal(served.type, "image/webp");
  assert.ok(served.body.length < animatedGif.length);
  const meta = await sharp(served.body, { animated: true }).metadata();
  assert.equal(meta.pages, 10);
  assert.deepEqual(meta.delay, Array(10).fill(90));
  assert.equal(meta.width, 160);
  assert.equal(await convertAnimated(`${base}/anim.gif`, "image-336"), 0);
});

test("a single-frame GIF is an ordinary still: it is resized instead of served at full size", async () => {
  const avatar = await produceImage(`${base}/static.gif`, "avatar-48");
  assert.equal(avatar.type, "image/webp");
  const meta = await sharp(avatar.body).metadata();
  assert.deepEqual([meta.width, meta.height], [48, 48]);
  assert.ok(avatar.body.length < staticGif.length / 4);
  const card = await produceImage(`${base}/static.gif`, "card");
  assert.equal((await sharp(card.body).metadata()).width, 336);
});

test("preparation finds every rendition a card and a page ask for, including escaped body images", async () => {
  const { proxiedRenditions } = await import("@aihot/backend/media/prepare");
  const { proxiedImage, proxiedImageSet, proxyBodyImages } = await import("@aihot/backend/media/imgproxy");
  const answers = [
    { avatar: proxiedImage("https://example.org/a.png?x=1&y=2", "avatar-48"), srcSet: proxiedImageSet("https://example.org/c.png", "card") },
    { html: proxyBodyImages('<img src="https://example.org/b.png?q=1&amp;r=2" width="800" height="400">') },
  ];
  const found = proxiedRenditions(answers).map((r) => `${r.mode} ${r.url}`).sort();
  assert.deepEqual(found, [
    "avatar-48 https://example.org/a.png?x=1&y=2",
    "full https://example.org/b.png?q=1&r=2",
    "image-1200 https://example.org/b.png?q=1&r=2",
    "image-1600 https://example.org/b.png?q=1&r=2",
    "image-336 https://example.org/c.png",
    "image-720 https://example.org/b.png?q=1&r=2",
    "image-720 https://example.org/c.png",
  ]);
});

test("a video source lends its own still, and a text source's photographs stay out of the page", () => {
  const media = videoMedia([
    { kind: "video", url: "https://www.youtube.com/watch?v=pKJDW8oOXuU", poster: "https://i1.ytimg.com/vi/pKJDW8oOXuU/hqdefault.jpg", width: 480, height: 360 },
    { kind: "image", url: "https://example.org/photo.jpg", width: 1200, height: 800 },
    { kind: "video", url: "https://www.youtube.com/shorts/abcdefghijklmnopqrstuvwxyz" },
    "not an object",
  ]);
  assert.equal(media.length, 1, "only a video entry with a poster qualifies");
  assert.equal(media[0]!.kind, "video");
  assert.equal(media[0]!.url, "https://www.youtube.com/watch?v=pKJDW8oOXuU", "the tile points at the platform, it is not a proxied image");
  assert.match(media[0]!.poster!, /img-proxy\?u=https%3A%2F%2Fi1\.ytimg\.com/);
  assert.deepEqual([media[0]!.width, media[0]!.height], [480, 360]);
  assert.ok(media[0]!.srcSet, "the still gets responsive candidates like any other picture");
});
