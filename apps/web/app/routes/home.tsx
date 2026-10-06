import { SITE } from "@aihot/industry/site";
import { data as withHeaders, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { PoolResponse, TimelineResponse } from "@aihot/contracts/site";
import { CATEGORY_LABELS, CHANNEL_LABELS, isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Wordmark } from "../components/Logo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { CategoryTabs, SearchField, SearchIconLink } from "../features/feed/Filters";
import { beijingDate, beijingWeekday, monthDayTime, shortSourceName } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(`/api/site/timeline${queryString({ channel: channel === "all" ? null : channel, category, tag })}`, { responseHeaders: upstream, signal: request.signal });
  // 精选是人工签署的那一层：没有新的签署，它就停在最后一次（2026-10-06 线上停在 10-02）。读者据此
  // 判断整站死了，而实时收录其实一直在走。所以精选超过三天没有动静时，首页把最新的实时条目摆出来，
  // 并写明这一层没有编辑筛选；精选恢复之后这一块自己消失，不跟「全部动态」抢位置。
  const newest = data.cards[0]?.anchorAt ? Date.parse(data.cards[0].anchorAt) : 0;
  const live = newest > 0 && newest < Date.now() - 3 * 86400_000
    ? await loadOr404<PoolResponse>(`/api/site/pool${queryString({ channel: channel === "all" ? null : channel, category, tag })}`, { signal: request.signal })
    : null;
  return withHeaders({ data, live, filters: { channel, category, tag, topic: null } }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
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

function TodayLabel() {
  const today = beijingDate(Date.now());
  const [, m, d] = today.split("-").map(Number) as [number, number, number];
  return (
    <span className="text-[12.5px] text-ink-4" suppressHydrationWarning>
      {m}月{d}日 · {beijingWeekday(today).replace("星期", "周")}
    </span>
  );
}

export default function Home() {
  const { data, live, filters } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${filters.tag}` : "精选";
  return (
    <div className="pb-6">
      {/* Phones: brand bar, today's hot topics, then the feed under "最新精选". */}
      <div className="flex h-14 items-center justify-between lg:hidden">
        <Wordmark size={20} className="text-ink" />
        <TodayLabel />
      </div>
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

      <h2 className="mt-6 text-[20px] font-bold text-ink lg:hidden">{filters.tag ? title : "最新精选"}</h2>
      <div className="-mx-4 mt-3 flex items-center gap-2 pl-4 pr-2 lg:hidden">
        <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-mobile" size="sm" className="min-w-0 flex-1" />
        <SearchIconLink />
      </div>

      {live && live.items.length > 0 && (
        <section aria-labelledby="live-title" className="mb-6 mt-3 rounded-card border border-line bg-surface px-4 py-3 lg:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line-soft pb-2">
            <h2 id="live-title" className="flex items-center gap-2 text-[15px] font-bold text-ink">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              最新收录
            </h2>
            <span className="text-[12px] text-ink-4">按收录时间排列，本站未作编辑筛选</span>
          </div>
          <ul className="divide-y divide-line-soft">
            {live.items.slice(0, 8).map((it) => {
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
          <Link to="/all" className="mt-2 inline-flex text-[13px] text-accent hover:underline">
            查看全部 {live.total.toLocaleString("zh-CN")} 条地理动态 →
          </Link>
        </section>
      )}

      <Timeline initial={data} filters={data.filters} />    </div>
  );
}
