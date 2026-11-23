// Share images (1200×630 PNG) for pages, items, reports, topics and events. Only public content
// gets a card; anything else is a real 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import { loadItemShare } from "@aihot/backend/publication/og";
import { loadReport, type ReportKind } from "@aihot/backend/publication/reports";
import { loadTopic } from "@aihot/backend/publication/topics";
import { loadStoryDetail, resolveStory } from "@aihot/backend/publication/stories";
import { SITE, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { config } from "@aihot/backend/config";
import { ogEtag, renderOg, type OgCard } from "../og/render.ts";
import { posterEtag, renderPoster, type Poster } from "../og/poster.ts";
import { looseQuery } from "../http/respond.ts";

const S = SITE.subject;
const PAGES: Record<string, OgCard> = {
  site: { kicker: SITE.name, title: SITE.tagline, subtitle: SITE.description },
  all: { kicker: `全部${withSubject("动态")}`, title: "所有信源的最新动态，一站看完", subtitle: "按时间汇总各信源的最新动态，可按类别与标签筛选。" },
  hot: { kicker: "热点榜", title: `过去 48 小时，大家在讨论什么`, subtitle: "热度指数、趋势与组成热度的公开来源。", accent: "hot" },
  daily: { kicker: withSubject("日报"), title: `每天 8 点，一份读得完的${withSubject("日报")}`, subtitle: `前一天值得关注的${S}动态。` },
  weekly: { kicker: withSubject("周报"), title: "一周大事，一次看清", subtitle: "本周的主线、重要发布与值得回看的讨论。" },
  monthly: { kicker: withSubject("月报"), title: "一个月的变化", subtitle: "月度主线与关键事件回顾。" },
  topics: { kicker: "主题", title: "长期追踪的方向", subtitle: "按区域与机构、自然与人文领域、内容与题材聚合。" },
  leaderboard: { kicker: `${SITE.name} 排行榜`, title: "多家公开评测的共识排名", subtitle: "综合、编程、推理、知识、专业办公；缺测不补零，价格不影响排名。" },
  "codex-reset": { kicker: "Tibo 重置监控", title: "Codex 额度重置什么时候生效", subtitle: "推算的北京时间窗口、适用范围与 Tibo 原话。", accent: "amber" },
  about: { kicker: "关于", title: `关于 ${SITE.name}`, subtitle: SITE.description },
  terms: { kicker: "使用规则", title: `${SITE.name} 使用规则`, subtitle: "网站、API、RSS 与 MCP 的使用范围。" },
  privacy: { kicker: "隐私说明", title: `${SITE.name} 隐私说明`, subtitle: "访问日志、浏览器本地数据与反馈资料的处理方式。" },
  changelog: { kicker: "更新日志", title: `${SITE.name} 更新日志`, subtitle: "功能更新、优化、公告与下线记录。" },
  feedback: { kicker: "反馈", title: "告诉我们哪里可以更好", subtitle: "内容、功能、接入，或来源方的更正与下架请求。" },
  agent: { kicker: "Agent 接入", title: `让 Agent 直接使用 ${SITE.name}`, subtitle: "MCP、RSS 与 REST API v1，匿名只读。" },
};

/** `/en` 静态分享卡的英文文案；业务内容卡（条目/刊/主题/事件）由读取层按 lang 投影。 */
const PAGES_EN: Record<string, OgCard> = {
  site: { kicker: SITE.name, title: "Geography news worth watching", subtitle: "Watched sources, events grouped, daily briefs written up." },
  all: { kicker: "All updates", title: "Every watched source in one timeline", subtitle: "Newest first, filterable by category and tag." },
  hot: { kicker: "Hot board", title: "What people discussed in the past 48 hours", subtitle: "Heat index, trend, and the public sources behind it.", accent: "hot" },
  daily: { kicker: "Daily", title: "One brief, every morning at 08:00", subtitle: "The geography stories worth reading from the day before." },
  weekly: { kicker: "Weekly", title: "A week in one read", subtitle: "The week's main line, major releases and discussions worth revisiting." },
  monthly: { kicker: "Monthly", title: "A month of change", subtitle: "Monthly main lines and key events reviewed." },
  topics: { kicker: "Topics", title: "Directions worth following", subtitle: "Grouped by region and institution, field, and format." },
  leaderboard: { kicker: `${SITE.name} leaderboard`, title: "Consensus rankings across public evaluations", subtitle: "Overall, coding, reasoning, knowledge and professional work; missing tests are never zero-filled." },
  "codex-reset": { kicker: "Tibo reset monitor", title: "When the Codex quota reset lands", subtitle: "The estimated window, scope, and Tibo's own words.", accent: "amber" },
  about: { kicker: "About", title: `About ${SITE.name}`, subtitle: "A geography news aggregator: watched sources, scored events, daily briefs." },
  terms: { kicker: "Terms", title: `${SITE.name} terms of use`, subtitle: "Scope of the website, API, RSS and MCP." },
  privacy: { kicker: "Privacy", title: `${SITE.name} privacy notice`, subtitle: "How access logs, browser-local data and feedback are handled." },
  changelog: { kicker: "Changelog", title: `${SITE.name} changelog`, subtitle: "Features, fixes, announcements and removals." },
  feedback: { kicker: "Feedback", title: "Tell us what could be better", subtitle: "Content, features, access, or a source's correction or takedown request." },
  agent: { kicker: "Agent access", title: `Use ${SITE.name} from an agent`, subtitle: "MCP, RSS and REST API v1; anonymous and read-only." },
};

function langOf(req: FastifyRequest): "zh" | "en" {
  return looseQuery(req).lang === "en" ? "en" : "zh";
}

/**
 * Cards that carry editorial text — an article's title and summary, an event's heading and latest
 * development, a report's lead. An item card got this bound on purpose (2026-10-02: after a withdrawal or a
 * correction they are gone from any cache within the hour); the event and report cards print the same kind of
 * withdrawable text and were inheriting the long default below, which let a shared cache serve an event that
 * the origin already answers 404 for (a merged story, a corrected daily): `s-maxage` was 7× the origin
 * max-age plus 24 hours of serve-stale — about 31 hours on an event card, about eight days on a daily one.
 * Same hour for all three now. One caveat measured on 2026-10-04 and recorded in `docs/known-issues.md`:
 * Cloudflare's Browser Cache TTL rewrites the visitor-facing `max-age` to 4 hours whatever the origin sends,
 * so this hour is enforced at the CDN tier (`s-maxage`), not in the reader's own cache.
 */
export const EDITORIAL_IMAGE_CACHE = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=600";
/**
 * Cards whose text is the site's own — the front page, a terms page, a topic's name and definition. Nothing
 * here is ever withdrawn from under a reader; it changes when the deployment changes, so a shared cache may
 * hold it for a week and revalidate by ETag after that.
 */
export const STATIC_IMAGE_CACHE = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400";
const ARTICLE_IMAGE_ORIGIN_SECONDS = "300";

/** Every card names the policy it wants: no route inherits a long shared-cache bound by forgetting an argument. */
async function send(req: FastifyRequest, reply: FastifyReply, card: OgCard, cacheControl: string) {
  const tag = `"og-${ogEtag(card)}"`;
  reply.header("ETag", tag).header("Cache-Control", cacheControl);
  if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
  return reply.type("image/png").send((await renderOg(card)).png);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).header("Cache-Control", "public, max-age=300").type("text/plain; charset=utf-8").send("Not found");
}

const REPORT_NAMES: Record<ReportKind, string> = { daily: withSubject("日报"), weekly: withSubject("周报"), monthly: withSubject("月报") };

export function registerOg(app: FastifyInstance) {
  app.get("/og/site.png", (req, reply) => send(req, reply, (langOf(req) === "en" ? PAGES_EN : PAGES).site!, STATIC_IMAGE_CACHE));

  app.get("/og/pages/:file", async (req, reply) => {
    const name = (req.params as { file: string }).file.replace(/\.png$/, "");
    // `PAGES["__proto__"]` 命中的是 Object.prototype（truthy），旧守卫会放它进渲染器再抛 TypeError。
    const source = langOf(req) === "en" ? PAGES_EN : PAGES;
    const card = Object.hasOwn(source, name) ? source[name] : undefined;
    if ((name === "leaderboard" && !FEATURES.leaderboard) || (name === "codex-reset" && !FEATURES.codexResetMonitor)) return notFound(reply);
    if (!card || typeof card.title !== "string" || !(req.params as { file: string }).file.endsWith(".png")) return notFound(reply);
    return send(req, reply, card, STATIC_IMAGE_CACHE);
  });

  app.get("/og/items/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const lang = langOf(req);
    const d = await loadItemShare(file.slice(0, -4), new Date(), lang);
    if (!d) return notFound(reply);
    reply.header("X-Accel-Expires", ARTICLE_IMAGE_ORIGIN_SECONDS);
    return send(req, reply, {
      kicker: d.category ? CATEGORY_LABELS[d.category] : (lang === "en" ? "Update" : withSubject("动态")),
      title: d.title,
      subtitle: d.summary,
      meta: `${d.source.name.replace(/（[^）]*）\s*$/, "")} · ${beijingDate(d.timelineAt)}`,
      badge: d.selected && d.score !== null ? { value: String(Math.round(d.score)), label: lang === "en" ? "Selected" : "精选评分" } : null,
    }, EDITORIAL_IMAGE_CACHE);
  });

  // Phone share poster for an article (1080×1440), generated on first request and cached by content.
  app.get("/og/posters/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const lang = langOf(req);
    const d = await loadItemShare(file.slice(0, -4), new Date(), lang);
    if (!d) return notFound(reply);
    const poster: Poster = {
      url: `${config.siteUrl}/items/${d.id}`,
      kicker: d.category ? CATEGORY_LABELS[d.category] : (lang === "en" ? "Update" : withSubject("动态")),
      title: d.title,
      summary: d.summary,
      source: d.source.name.replace(/（[^）]*）\s*$/, ""),
      date: beijingDate(d.timelineAt),
      score: d.selected ? d.score : null,
    };
    const tag = `"poster-${posterEtag(poster)}"`;
    reply.header("ETag", tag).header("Cache-Control", EDITORIAL_IMAGE_CACHE).header("X-Accel-Expires", ARTICLE_IMAGE_ORIGIN_SECONDS);
    if (String(req.headers["if-none-match"] ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === tag)) return reply.code(304).send();
    return reply.type("image/png").send((await renderPoster(poster)).png);
  });

  app.get("/og/reports/:kind/:file", async (req, reply) => {
    const { kind, file } = req.params as { kind: string; file: string };
    if (!["daily", "weekly", "monthly"].includes(kind) || !file.endsWith(".png")) return notFound(reply);
    const lang = langOf(req);
    const r = await loadReport(kind as ReportKind, file.slice(0, -4), lang);
    if (!r) return notFound(reply);
    const names = lang === "en"
      ? { daily: "Daily", weekly: "Weekly", monthly: "Monthly" }
      : REPORT_NAMES;
    return send(req, reply, {
      kicker: `${names[r.kind]} · ${r.key}`,
      title: r.lead?.title ?? r.title,
      subtitle: r.lead?.leadParagraph ?? r.overview,
      meta: lang === "en"
        ? `${r.stories.length} ${r.stories.length === 1 ? "story" : "stories"}${r.readingMinutes > 0 ? ` · about ${r.readingMinutes} min read` : ""}`
        : `${r.stories.length} 件大事${r.readingMinutes > 0 ? ` · 约 ${r.readingMinutes} 分钟读完` : ""}`,
    }, EDITORIAL_IMAGE_CACHE);
  });

  app.get("/og/topics/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const t = file.endsWith(".png") ? await loadTopic(file.slice(0, -4)) : null;
    if (!t) return notFound(reply);
    const lang = langOf(req);
    return send(req, reply, {
      kicker: lang === "en" ? "Topic" : "主题",
      title: lang === "en" && t.name_en?.trim() ? t.name_en : t.name,
      subtitle: lang === "en" && t.definition_en?.trim() ? t.definition_en : t.definition,
    }, STATIC_IMAGE_CACHE);
  });

  app.get("/og/stories/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!file.endsWith(".png")) return notFound(reply);
    const found = await resolveStory(file.slice(0, -4));
    if (found.kind !== "found") return notFound(reply);
    const lang = langOf(req);
    const s = await loadStoryDetail(found.storyId, new Date(), lang);
    if (!s) return notFound(reply);
    return send(req, reply, {
      kicker: s.whyHot.rank ? (lang === "en" ? `Hot #${s.whyHot.rank} · Event` : `热点第 ${s.whyHot.rank} · 事件`) : (lang === "en" ? "Event" : "事件"),
      title: s.title,
      subtitle: s.latest ?? s.digest,
      meta: lang === "en" ? `${s.sourceCount} sources · ${s.reportCount} reports` : `${s.sourceCount} 个来源 · ${s.reportCount} 篇报道`,
      accent: s.whyHot.rank ? "hot" : "teal",
    }, EDITORIAL_IMAGE_CACHE);
  });
}
