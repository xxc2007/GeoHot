import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { PoolResponse, TimelineResponse } from "@aihot/contracts/site";
import { CATEGORY_LABELS, CHANNEL_LABELS, isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Timeline } from "../features/feed/Timeline";
import { useEffect, useState } from "react";
import { MobileDaySection, MobileHomeTop, MobilePoolList, type FeedTab } from "../features/feed/MobileHome";
import { useLivePublicData } from "../lib/use-live-public-data";
import { HotTopics } from "../features/feed/HotTopics";
import { CategoryTabs, SearchField } from "../features/feed/Filters";
import { beijingDate, monthDayTime, shortSourceName } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  // 与 /all 同一条规则：分类键不在词表里（含 2026-10-09 删掉的 `geoedu`）就 404，不再静默显示无过滤的时间轴。
  if (categoryParam && !isCategoryKey(categoryParam)) throw new Response("Not found", { status: 404 });
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  // 手机首屏那两段（精选 / 全部）在同一个路由里切换：两份第一页都在这一屏取好，
  // 切换只是换一块已经在内存里的列表——不再过网络，也不会白屏。
  const tab: FeedTab = url.searchParams.get("tab") === "all" ? "all" : "selected";
  const scope = { channel: channel === "all" ? null : channel, category, tag };
  const upstream = new Headers();
  // Keep the first document light; Timeline continues from this cursor in 40-card batches.
  const [data, pool] = await Promise.all([
    loadOr404<TimelineResponse>(`/api/site/timeline${queryString({ ...scope, limit: 12 })}`, { responseHeaders: upstream, signal: request.signal }),
    loadOr404<PoolResponse>(`/api/site/pool${queryString({ ...scope, limit: 12 })}`, { signal: request.signal }),
  ]);
  // 精选按站长制定的标准由模型筛选，也可在后台更正。精选超过三天没有更新时，
  // 展示仍在更新的收录池；其中部分条目未达精选标准。精选恢复后这一块自动消失。
  const newest = data.cards[0]?.anchorAt ? Date.parse(data.cards[0].anchorAt) : 0;
  const stale = newest > 0 && newest < Date.now() - 3 * 86400_000;
  // The fallback shows eight headlines. Do not serialize 40 summaries, scores and tags into hydration.
  const live = stale ? { total: pool.total, items: pool.items.slice(0, 8).map(({ id, title, timelineAt, publishedAt, source }) => ({
    id, title, timelineAt, publishedAt, source: { name: source.name },
  })) } : null;
  return withHeaders({ data, pool, tab, live, filters: { channel, category, tag, topic: null } }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

/**
 * 筛选出来的那一页要自己报名。canonical 已经按 `listPath()` 把 category/channel/tag 写进地址，
 * 标题却一直是默认的站点标题——读者停在 `/?category=hazard` 上，标签页、分享卡片和搜索结果说的
 * 都是首页。标题、`og:title`、`twitter:title` 同源（`pageMeta` 只读 `title` 这一个入参），
 * 所以改这一处三者一起跟上，canonical 与 og 不会各说各话。
 */
function filterLabel(f: { channel: string; category: string | null; tag: string | null } | undefined): string | null {
  if (!f) return null;
  const what = f.tag ? `#${f.tag}` : f.category && isCategoryKey(f.category) ? CATEGORY_LABELS[f.category] : null;
  const where = f.channel !== "all" && isChannelKey(f.channel) ? CHANNEL_LABELS[f.channel] : null;
  const parts = [what, where].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}精选` : null;
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag });
  const label = filterLabel(f);
  return pageMeta({
    title: label,
    description: label ? `${SITE.name} 的${label}：按这一筛选的精选与时间线。` : undefined,
    path,
    jsonLd: path === "/" ? organizationLd() : undefined,
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}


export default function Home() {
  const { data: initial, pool, tab: initialTab, live, filters } = useLoaderData<typeof loader>();
  // 手机上的「精选 / 全部」是一屏里的两段：点一下只换列表，不再过一次加载。
  // 地址栏跟着写 `?tab=all`（replaceState，不触发导航），这样分享出去的链接还能落在同一段；
  // 前进/后退时 loader 重新给 `initialTab`，下面的 effect 把状态拉回去。
  const [tab, setTab] = useState<FeedTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const chooseTab = (next: FeedTab) => {
    setTab(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.set("tab", "all");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url);
  };
  const params = new URLSearchParams({ limit: "12" });
  if (filters.channel !== "all") params.set("channel", filters.channel);
  if (filters.category) params.set("category", filters.category);
  if (filters.tag) params.set("tag", filters.tag);
  const data = useLivePublicData(initial, `/api/site/timeline?${params}`);
  const title = filters.tag ? `#${filters.tag}` : "精选";
  // 日期栏右侧那个"N 条"是当天的时间线总条数，来自响应里的 `dayCounts`（服务端按北京日期分桶），
  // 不是这一屏已经渲染的 12 张卡——否则读者会看到"12 条"，然后往下滚还有几十张。
  const todayCount = data.dayCounts[beijingDate(Date.now())] ?? null;
  return (
    <div className="pb-6">
      {/* 手机：搜索条 + 品牌行（精选/全部 切换）——站长 2026-11-04 截图里的第一屏。 */}
      <MobileHomeTop category={filters.category} channel={filters.channel} tab={tab} onTab={chooseTab} />
      {/* One h1 at every width: on phones it is read but not drawn (the brand bar and 最新精选 already own that
          space), from lg it is the visible page title, exactly as before. Only the desktop filter row is hidden. */}
      <h1 className="sr-only text-[24px] font-semibold leading-[1.3] text-ink lg:not-sr-only">{title}</h1>
      <div className="hidden lg:block">
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField variant="track" keep={{ category: filters.category }} />
        </div>
      </div>

      {data.hot && <HotTopics asOf={data.hotAsOf} entries={data.hot} generatedAt={data.generatedAt} />}

      {live && live.items.length > 0 && (
        <section aria-labelledby="live-title" className="mb-6 mt-3 rounded-card border border-line bg-surface px-4 py-3 lg:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line-soft pb-2">
            <h2 id="live-title" className="flex items-center gap-2 text-[15px] font-bold text-ink">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              最新收录
            </h2>
            <span className="text-[12px] text-ink-4">按收录时间排列，部分条目未达精选标准</span>
          </div>
          <ul className="divide-y divide-line-soft">
            {live.items.map((it) => {
              const at = it.timelineAt ?? it.publishedAt;
              return (
                <li key={it.id} className="flex items-baseline gap-3 py-2">
                  <span className="mono w-[86px] shrink-0 text-[12px] tabular-nums text-ink-4">{at ? monthDayTime(at) : "未注明"}</span>
                  <Link to={`/items/${it.id}`} className="min-w-0 flex-1 text-[14px] leading-[1.65] text-ink transition-colors hover:text-accent">
                    {it.title}
                  </Link>
                  <span className="hidden w-[104px] shrink-0 truncate text-right text-[12px] text-ink-4 sm:block">{shortSourceName(it.source.name)}</span>
                </li>
              );
            })}
          </ul>
          {/* 那个数是**带筛选**的池子总数，链接就必须带着同一组筛选：第三十四轮评审实测
              `/?category=physical` 上印着「查看全部 245 条」而链接指向裸 /all（未筛 2000+ 条），
              读者点过去看到的条数比标题大一个数量级。canonical 早就用 `listPath` 带上了筛选。 */}
          <Link
            to={listPath("/all", { channel: filters.channel !== "all" ? filters.channel : null, category: filters.category, tag: filters.tag })}
            className="mt-2 inline-flex text-[13px] text-accent hover:underline"
          >
            查看全部 {live.total.toLocaleString("zh-CN")} 条{withSubject("动态")} →
          </Link>
        </section>
      )}

      {/* 手机切「精选 / 全部」只换这一块里的列表：日期栏留着（它说的是"今天有多少条"），
          两段共用同一条折叠开关。Timeline 只渲染一份——窄屏切到「全部」时用 `max-lg:hidden`
          让位，桌面永远显示精选。 */}
      <MobileDaySection count={tab === "all" ? pool.todayCount : todayCount}>
        <div className={tab === "all" ? "max-lg:hidden" : undefined}>
          <Timeline initial={data} filters={data.filters} />
        </div>
        <div className={tab === "all" ? undefined : "hidden"}>
          <MobilePoolList pool={pool} filters={filters} />
        </div>
      </MobileDaySection>
    </div>
  );
}
