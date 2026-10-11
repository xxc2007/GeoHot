import { SITE, withSubject } from "@aihot/industry/site";
import { Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/all";
import type { PoolResponse } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { beijingDate, isDay, isMonth } from "@aihot/contracts/time";
import { loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { CategoryTabs, SearchField } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { DateCalendar, type CalendarDay } from "../features/calendar/DateCalendar";
import { beijingTime, todayOf } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { RingMark } from "../components/Logo";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  // 分类键是词表里那七个之一。写错的、或已经被删掉的键（`geoedu` 于 2026-10-09 删除）以前会被**静默忽略**：
  // 页面照常显示 40 张无过滤的卡片，翻页链接还带着那个不存在的键；而 `/api/v1/items?category=…` 回 400、
  // `/feed/category/<key>.xml` 回 404——同一个参数在三个出口三种说法（2026-10-11 评审波实测）。
  if (categoryParam && !isCategoryKey(categoryParam)) throw new Response("Not found", { status: 404 });
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : null;
  // 日历选的那一天，以及日历正看着的那一个月。两个都按上面 `category` 那条规矩办：认不出来就 404，
  // 不安静地当成"没有筛选"——否则读者点 3 月却看到 10 月的卡片，比报错更难查。
  const dateParam = url.searchParams.get("date");
  if (dateParam && !isDay(dateParam)) throw new Response("Not found", { status: 404 });
  const date = dateParam && isDay(dateParam) ? dateParam : null;
  const monthParam = url.searchParams.get("month");
  if (monthParam && !isMonth(monthParam)) throw new Response("Not found", { status: 404 });
  const month = (monthParam && isMonth(monthParam) ? monthParam : null) ?? date?.slice(0, 7) ?? beijingDate(Date.now()).slice(0, 7);
  // Legacy deep-paging parameters (deep, anchorAt) still open a normal page.
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const [data, calendar] = await Promise.all([
    loadOr404<PoolResponse>(
      `/api/site/pool${queryString({ channel: channel === "all" ? null : channel, category, tag, q, tab, page: page > 1 ? page : null, date })}`,
      { signal: request.signal, busyRedirect: "/all/search-busy" },
    ),
    // 日历那一格拿不到不该把整页拖下水：列表自己会说"这一天没有内容"。
    loadOr404<{ month: string; days: CalendarDay[] }>(`/api/site/calendar?month=${month}`, { signal: request.signal })
      .catch(() => ({ month, days: [] as CalendarDay[] })),
  ]);
  return { data, calendar, date, month };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.data.filters;
  const q = f?.q;
  const page = loaderData?.data.page ?? 1;
  return pageMeta({
    // The <h1> says `#tag` when a tag filtered the list (line 74); the tab title did not, so a tag page
    // announced itself as 「全部地理动态」 to tabs and search engines alike (real-browser pass, 2026-10-04).
    title: q ? `搜索“${q}”` : f?.tag ? `#${f.tag}` : `全部${withSubject("动态")}`,
    description: `${SITE.name} 收录的全部${withSubject("动态")}，可按类别与标签筛选，支持中英文搜索。`,
    path: listPath("/all", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag, q, tab: f?.tab === "relevance" ? "relevance" : null, page: page > 1 ? page : null, date: loaderData?.date ?? null }),
    image: "/og/pages/all.png",
    noindex: !!q,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30" };
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/all?${s}` : "/all";
}

export default function AllPage() {
  const { data, calendar, date, month } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const f = data.filters;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/all";
  const keep = { channel: f.channel === "all" ? null : f.channel, category: f.category, tag: f.tag };
  // 日历的两种走法：点某一天 = 带着当前筛选去看那一天；换月份 = 只看那一月的日历，不留在旧的那一天上。
  const listHref = (over: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ channel: f.channel === "all" ? null : f.channel, category: f.category, tag: f.tag, date, month, ...over })) {
      if (v) sp.set(k, v);
    }
    const q = sp.toString();
    return q ? `/all?${q}` : "/all";
  };
  const dayHref = (d: string) => listHref({ date: d, month: d.slice(0, 7) });
  const monthHref = (m: string) => listHref({ date: null, month: m });
  const cnDate = (d: string) => `${Number(d.slice(0, 4))} 年 ${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    return `/all?${sp}`;
  };
  const title = f.q ? `搜索“${f.q}”` : f.tag ? `#${f.tag}` : null;
  // The same clock the rest of the site prints times with (`/hot` shows 16:31 for this same concept);
  // `toLocaleTimeString("zh-CN")` rendered it as 下午04:31 here and nowhere else.
  const updated = beijingTime(data.freshness);

  return (
    <div className="pb-6">
      {/* Desktop, as on 精选: the title, then one filter row with the search field aligned on the right. */}
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title ?? `全部${withSubject("动态")}`}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-desk" className="min-w-0" />
          <SearchField variant="track" defaultValue={f.q ?? ""} keep={keep} />
        </div>
      </div>

      {/* Phones: title with today's count, the search bar, then the same filter row as 精选. */}
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between pb-3 pt-5">
          <h1 className="text-[22px] font-bold text-ink">{title ?? `全部${withSubject("动态")}`}</h1>
          {!f.q && (
            <span className="text-[12.5px] text-ink-4">
              今日 <span className="num">{data.todayCount}</span> 条
            </span>
          )}
        </div>
        <SearchField variant="bar" defaultValue={f.q ?? ""} keep={keep} autoFocus={params.get("search") === "1"} />
        <div className="-mx-4 mt-3 border-b border-line-soft px-4 pb-3">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-mobile" size="sm" className="min-w-0" />
        </div>
      </div>

      {f.q && (
        <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          <PillTabs
            size="xs"
            layoutId="all-search-sort"
            label="搜索排序"
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({ key: t, label: t === "time" ? "最新（标题与摘要）" : "全文相关", to: searchTabHref(t) }))}
          />
          <span className="text-[12px] text-ink-4">
            找到 <span className="num">{data.total >= 2000 ? "2000+" : data.total}</span> 条 · 更新于 <span className="num">{updated}</span>
          </span>
        </div>
      )}

      <DateCalendar className="mb-4" month={month} days={calendar.days} selected={date} today={todayOf(data.generatedAt)} dayHref={dayHref} monthHref={monthHref} unit="条" />
      {date && (
        <p className="-mt-1 mb-3 text-[12px] text-ink-4">
          正在只看 {cnDate(date)} 那一天 ·
          <Link to={listHref({ date: null, month: null })} className="ml-1 inline-flex min-h-9 items-center font-medium text-accent hover:underline">看全部日期</Link>
        </p>
      )}

      {/* A section heading for the list itself. The cards are <h3>, and on every other board the level
          above them is a real section title ("精选", "最新"); here the page title <h1> sat straight on
          top of <h3>, which Lighthouse reads as a skipped level (the heading-order audit) and a screen
          reader reading by headings reads as "no list section". Hidden, because the design has no label
          at this spot — the page title above already says what the list is. */}
      <h2 className="sr-only">{f.q ? "搜索结果" : "全部动态"}</h2>
      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title="没有找到相关内容"
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    试试“全文相关”，连正文一起搜
                  </Link>
                ) : undefined
              }
            >
              {f.q ? "换个说法，或者去掉筛选再试。" : date ? "那一天没有收录到的条目——日历上只有有内容的日子才是点得动的。" : "这个筛选下暂时没有内容。"}
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} today={todayOf(data.generatedAt)} todayCount={f.q ? null : data.todayCount} showTags />
        )}
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
      {data.page >= 50 && <p className="mt-4 text-center text-[12px] text-ink-4">最多提供 50 页；更早的日子请用上面这张日历挑一天，或者用搜索、主题页。</p>}
    </div>
  );
}

export function SearchBusy() {
  return (
    <div className="mx-auto max-w-sm py-24 text-center">
      <RingMark className="mx-auto mb-5 size-10 text-accent" spinning />
      <h1 className="text-[20px] font-bold text-ink">搜索有点忙</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-3">现在搜索的人比较多，请稍等几秒再试。列表浏览不受影响。</p>
      <div className="mt-6 flex justify-center gap-2.5">
        <Link to="/all" className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-contrast hover:bg-accent-ink">浏览全部动态</Link>
        <Link to="/" reloadDocument className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13.5px] text-ink-2 hover:border-ink-4">回到精选</Link>
      </div>
    </div>
  );
}
