import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";
import { FEATURES } from "@aihot/industry/features";

export default [
  index("routes/home.tsx"),
  route("all", "routes/all.tsx"),
  // `/all` 的繁忙页是唯一被跳转到的那一个（`all.tsx` 的 busyRedirect）；根上那条 `/search-busy` 从来没有
  // 任何链接或跳转指向它，读者只能从旧书签进来，是一份没人认领的副本，本轮删掉。
  route("all/search-busy", "routes/search-busy.tsx", { id: "all-search-busy" }),
  route("items/:id", "routes/item.tsx"),
  route("items/:id/original", "routes/item-original.tsx", { id: "item-original" }),
  route("hot", "routes/hot.tsx"),
  route("story/:publicId", "routes/story.tsx"),
  route("daily", "routes/report-latest.tsx", { id: "daily-latest" }),
  route("daily/archive", "routes/daily-archive.tsx"),
  route("daily/:key", "routes/report-detail.tsx", { id: "daily-detail" }),
  route("weekly", "routes/report-latest.tsx", { id: "weekly-latest" }),
  route("weekly/:key", "routes/report-detail.tsx", { id: "weekly-detail" }),
  route("monthly", "routes/report-latest.tsx", { id: "monthly-latest" }),
  route("monthly/:key", "routes/report-detail.tsx", { id: "monthly-detail" }),
  route("topics", "routes/topics.tsx"),
  route("topics/:slug", "routes/topic.tsx", { id: "topic" }),
  route("topics/:slug/page/:page", "routes/topic.tsx", { id: "topic-page" }),
  route("about", "routes/about.tsx"),
  route("terms", "routes/terms.tsx"),
  route("privacy", "routes/privacy.tsx"),
  route("changelog", "routes/changelog.tsx"),
  route("feedback", "routes/feedback.tsx"),
  route("more", "routes/more.tsx"),
  route("starred", "routes/starred.tsx"),
  route("agent", "routes/agent.tsx"),
  // 英文界面框架：读者面每条路由的 /en 前缀副本，同一组件文件、id 加 `en-` 前缀。组件里的界面串
  // 按 `lib/i18n.ts` 从路径判定语言后取字典；文章标题、摘要与日报正文仍是中文动态内容（页面自行
  // 标注）。admin 与 leaderboard 不注册——leaderboard 本就由 FEATURES.leaderboard 关闭（见上），
  // admin 保持中文 chrome，不进英文界面。
  route("en", "routes/home.tsx", { id: "en-home", index: true }),
  route("en/all", "routes/all.tsx", { id: "en-all" }),
  route("en/all/search-busy", "routes/search-busy.tsx", { id: "en-all-search-busy" }),
  route("en/items/:id", "routes/item.tsx", { id: "en-items" }),
  route("en/items/:id/original", "routes/item-original.tsx", { id: "en-item-original" }),
  route("en/hot", "routes/hot.tsx", { id: "en-hot" }),
  route("en/story/:publicId", "routes/story.tsx", { id: "en-story" }),
  route("en/daily", "routes/report-latest.tsx", { id: "en-daily-latest" }),
  route("en/daily/archive", "routes/daily-archive.tsx", { id: "en-daily-archive" }),
  route("en/daily/:key", "routes/report-detail.tsx", { id: "en-daily-detail" }),
  route("en/weekly", "routes/report-latest.tsx", { id: "en-weekly-latest" }),
  route("en/weekly/:key", "routes/report-detail.tsx", { id: "en-weekly-detail" }),
  route("en/monthly", "routes/report-latest.tsx", { id: "en-monthly-latest" }),
  route("en/monthly/:key", "routes/report-detail.tsx", { id: "en-monthly-detail" }),
  route("en/topics", "routes/topics.tsx", { id: "en-topics" }),
  route("en/topics/:slug", "routes/topic.tsx", { id: "en-topic" }),
  route("en/topics/:slug/page/:page", "routes/topic.tsx", { id: "en-topic-page" }),
  route("en/about", "routes/about.tsx", { id: "en-about" }),
  route("en/terms", "routes/terms.tsx", { id: "en-terms" }),
  route("en/privacy", "routes/privacy.tsx", { id: "en-privacy" }),
  route("en/changelog", "routes/changelog.tsx", { id: "en-changelog" }),
  route("en/feedback", "routes/feedback.tsx", { id: "en-feedback" }),
  route("en/more", "routes/more.tsx", { id: "en-more" }),
  route("en/starred", "routes/starred.tsx", { id: "en-starred" }),
  route("en/agent", "routes/agent.tsx", { id: "en-agent" }),
  // 模型榜是 AI 行业专属模块：FEATURES.leaderboard=false 时不注册路由，对应 chunk 不进构建产物。
  // 旧链接的公开重定向（/leaderboard/methodology、/leaderboard/category/(aesthetics|writing)）仍在
  // packages/contracts/src/http-policy.ts 的 REDIRECTS 里保留，不需要页面路由也能工作。
  ...(FEATURES.leaderboard
    ? [
        layout("routes/leaderboard-boards.tsx", [
          route("leaderboard", "routes/leaderboard.tsx", { id: "leaderboard" }),
          route("leaderboard/category/:key", "routes/leaderboard.tsx", { id: "leaderboard-category" }),
        ]),
        route("leaderboard/sources", "routes/leaderboard-sources.tsx"),
        route("leaderboard/sources/:key", "routes/leaderboard-source.tsx"),
        route("leaderboard/rules", "routes/leaderboard-rules.tsx"),
        route("leaderboard/:slug", "routes/leaderboard-model.tsx"),
      ]
    : []),
  route("admin/login", "routes/admin-login.tsx"),
  layout("routes/admin/layout.tsx", { id: "admin-layout" }, [
    route("admin", "routes/admin/index.tsx"),
    route("admin/content", "routes/admin/content.tsx"),
    route("admin/content/:id", "routes/admin/content-item.tsx"),
    route("admin/sources", "routes/admin/sources.tsx"),
    route("admin/sources/new", "routes/admin/source-new.tsx"),
    route("admin/sources/:id", "routes/admin/source.tsx"),
    route("admin/discovery", "routes/admin/discovery.tsx"),
    route("admin/feedback", "routes/admin/feedback.tsx"),
    route("admin/runs", "routes/admin/runs.tsx"),
    route("admin/server", "routes/admin/server.tsx"),
    route("admin/magpie", "routes/admin/magpie.tsx"),
    route("admin/models", "routes/admin/models.tsx"),
    route("admin/usage", "routes/admin/usage.tsx"),
    route("admin/settings", "routes/admin/settings.tsx"),
    route("admin/topics", "routes/admin/topics.tsx"),
    route("admin/audit", "routes/admin/audit.tsx"),
  ]),
] satisfies RouteConfig;
