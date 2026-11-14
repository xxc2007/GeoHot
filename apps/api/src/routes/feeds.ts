// RSS routes. Unknown query parameters are accepted and never change content.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RSS_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { dailyFeed, isFeedCategory, itemFeed, reportFeed, type ItemFeedKind } from "@aihot/backend/publication/feeds";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";

async function sendFeed(req: FastifyRequest, reply: FastifyReply, xml: string) {
  applyPublicHeaders(reply, { cors: false });
  return sendTextWithEtag(req, reply, xml, { etagPrefix: "rss", cacheControl: RSS_CACHE_CONTROL, contentType: "application/rss+xml; charset=utf-8" });
}

function feedError(reply: FastifyReply) {
  return reply.code(503).header("Retry-After", "60").header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Feed temporarily unavailable");
}

// 2026-11-14：一条 /feed/all.xml 在生产上实测要 66–168 秒（`listedCondition` 里带
// `EXISTS article_workflow_readiness`，再按 `coalesce(published_at, discovered_at)` 排序，
// 没有能裁剪的索引）。它虽然不走 public read 的槽，却把同一块慢盘占满，
// 别的读者就被判 busy 拿到 503。订阅源本来就是分钟级内容，这里加一层进程内缓存：
// 十分钟内只算一次，且过期后**先给旧的再后台换新**，任何一位读者都不必等它算完。
export const FEED_TTL_MS = 10 * 60_000;
const FEED_STALE_MS = 6 * 3600_000;
type Cached = { xml: string; at: number };
const feedCache = new Map<string, Cached>();
const feedPending = new Map<string, Promise<string>>();

export function cachedFeed(key: string, build: () => Promise<string>): Promise<string> {
  const hit = feedCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < FEED_TTL_MS) return Promise.resolve(hit.xml);
  const inflight = feedPending.get(key);
  if (inflight) return hit && now - hit.at < FEED_STALE_MS ? Promise.resolve(hit.xml) : inflight;
  if (hit && now - hit.at < FEED_STALE_MS) {
    // 有旧的就先交出去，刷新在后台跑；下一次请求拿到的就是新的。
    const refresh = build()
      .then((xml) => {
        feedCache.set(key, { xml, at: Date.now() });
        return xml;
      })
      .catch(() => hit.xml)
      .finally(() => feedPending.delete(key));
    feedPending.set(key, refresh);
    return Promise.resolve(hit.xml);
  }
  const first = build()
    .then((xml) => {
      feedCache.set(key, { xml, at: Date.now() });
      return xml;
    })
    .finally(() => feedPending.delete(key));
  feedPending.set(key, first);
  return first;
}

export function registerFeeds(app: FastifyInstance) {
  // A preflight gets 204 and the allowed methods; feeds send no CORS headers.
  for (const url of ["/feed.xml", "/feed/full.xml", "/feed/all.xml", "/feed/daily.xml", "/feed/weekly.xml", "/feed/monthly.xml", "/feed/category/:file", "/feed/full/category/:file"]) {
    app.options(url, async (_req, reply) => reply.code(204).header("Allow", "GET, HEAD, OPTIONS").send());
  }
  const item = (kind: ItemFeedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await sendFeed(req, reply, await cachedFeed(`item:${kind}`, () => itemFeed(kind, null)));
    } catch (error) {
      req.log.error({ err: error }, "feed error");
      return feedError(reply);
    }
  };
  app.get("/feed.xml", item("selected"));
  app.get("/feed/full.xml", item("selected-full"));
  app.get("/feed/all.xml", item("all"));
  app.get("/feed/daily.xml", async (req, reply) => {
    try {
      return await sendFeed(req, reply, await cachedFeed("daily", () => dailyFeed()));
    } catch (error) {
      req.log.error({ err: error }, "feed error");
      return feedError(reply);
    }
  });
  for (const kind of ["weekly", "monthly"] as const) {
    app.get(`/feed/${kind}.xml`, async (req, reply) => {
      try {
        return await sendFeed(req, reply, await cachedFeed(`report:${kind}`, () => reportFeed(kind)));
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
  for (const full of [false, true]) {
    app.get(full ? "/feed/full/category/:file" : "/feed/category/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const slug = file.replace(/\.xml$/, "");
      if (!file.endsWith(".xml") || !isFeedCategory(slug)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      try {
        const kind: ItemFeedKind = full ? "selected-full" : "selected";
        return await sendFeed(req, reply, await cachedFeed(`cat:${kind}:${slug}`, () => itemFeed(kind, slug)));
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
}
