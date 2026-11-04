// 手机首页的外壳：搜索条、精选/全部 切换、日期栏与可折叠的正文。
//
// 版式来自站长 2026-11-04 给的 AIHOT 截图：最上面一条搜索框（带"搜索"按钮），下面一行品牌 +
// 两段切换 + 两个图标，再下面"当前热点"、日期栏，最后才是信息流。这里只搬版式，内容一律用本站
// 自己的数据：本站没有"模型榜"与"我的"，那两格在底部导航里换成本站真实存在的栏目（见 nav.ts）。
//
// 2026-11-04 第二轮：精选与全部不再是两个页面。首屏 loader 把两份第一页都取好，切换只改一个
// 客户端状态（并把 tab 写进地址栏），所以点下去立刻换列表，没有整页刷新、也没有二次请求。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { FeedItemSummary, PoolResponse, TimelineFilters } from "@aihot/contracts/site";
import { Wordmark } from "../../components/Logo";
import { IconChevronDown, IconClock, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { beijingDate, beijingWeekday } from "../../lib/format";
import { listPath } from "../../lib/seo";
import { publicPath } from "../../lib/public-path";
import { FeedItem } from "./FeedItem";
import { TimelineSlot } from "./Timeline";
import { SearchField } from "./Filters";

export type FeedTab = "selected" | "all";

/** 精选 / 全部 两段切换：受控组件，切换不导航（两边的数据都在首屏 loader 里）。 */
export function MobileFeedSwitch({ value, onChange }: { value: FeedTab; onChange: (next: FeedTab) => void }) {
  return (
    <PillTabs
      items={[
        { key: "selected", label: "精选" },
        { key: "all", label: "全部" },
      ]}
      active={value}
      onSelect={(key) => onChange(key === "all" ? "all" : "selected")}
      layoutId="mobile-feed-switch"
      size="sm"
      label="列表"
    />
  );
}

/**
 * 手机首页第一屏：搜索条 + 品牌行。
 *
 * 搜索条与 /all 页同一个组件（`SearchField variant="bar"`），走 GET `/all?q=`，所以键盘回车、
 * 屏幕阅读器的 `role="search"` 和浏览器的"后退保留输入"都跟桌面一致，不另写一套。
 */
export function MobileHomeTop({ category, channel, tab, onTab }: { category: string | null; channel: string; tab: FeedTab; onTab: (next: FeedTab) => void }) {
  return (
    <div className="lg:hidden">
      <div className="pt-1">
        <SearchField variant="bar" keep={{ category, channel: channel === "all" ? null : channel }} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <Wordmark size={20} className="text-ink" />
        <MobileFeedSwitch value={tab} onChange={onTab} />
        <div className="flex shrink-0 items-center gap-1">
          <Link
            to="/daily"
            aria-label="日报"
            className="grid size-9 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink"
          >
            <IconClock size={18} />
          </Link>
          <Link
            to="/all?search=1"
            aria-label="搜索"
            className="grid size-9 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink"
          >
            <IconSearch size={18} />
          </Link>
        </div>
      </div>
    </div>
  );
}

function todayLabel(now: number): string {
  const today = beijingDate(now);
  const [, m, d] = today.split("-").map(Number) as [number, number, number];
  return `今天 · ${m}月${d}日 ${beijingWeekday(today).replace("星期", "周")}`;
}

/**
 * 日期栏 + 可折叠的这一天。截图里「今天 11月4日 周三 / N 条」右侧是一个展开箭头；这里点整条
 * 都可以收起，`aria-expanded` 让读屏也知道正文现在藏起来了。默认展开——第一次来的读者不该先看到
 * 一个空的页面。
 */
export function MobileDaySection({ count, children }: { count: number | null; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label="今天的条目">
      {/* 只在手机上出现的日期栏；桌面的同一块正文照旧不带这条栏，也不受它折叠影响。 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        // 日期不是浏览器时间：服务端与客户端都读同一个北京时间函数，水合不会翻脸。
        className="mt-5 flex w-full items-center justify-between border-b border-line-soft pb-2 text-left lg:hidden"
      >
        <span className="text-[13px] font-semibold text-ink-2" suppressHydrationWarning>
          {todayLabel(Date.now())}
        </span>
        <span className="flex items-center gap-2 text-[12px] text-ink-4">
          {count === null ? "—" : `${count} 条`}
          <IconChevronDown
            size={15}
            className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
        </span>
      </button>
      <div className={open ? "" : "hidden"}>{children}</div>
    </section>
  );
}

/**
 * 「全部」那一段：与 `/all` 一样的"一直往下拉"，不再是"看 12 条 + 点一下去全部列表"。
 *
 * 站长 2026-11-04 当面反馈：手机上划到 12 条就出现「查看全部 2,000 条动态」，点一下才能继续读，
 * 而 web 端 `/all` 早已是触底自动续。这里改成同一套：首屏由 loader 渲染第一页（40 条），
 * 之后用 IntersectionObserver 触底取下一页，按 id 去重，取完显示「已经到底了。」。
 *
 * 与 `/all` 的差别只在卡片：这边用 `TimelineSlot` + `FeedItem`（带左侧时间格），保持与精选一致。
 */
const MAX_PAGE = 50;

function poolQuery(filters: TimelineFilters, page: number): string {
  const sp = new URLSearchParams();
  if (filters.channel && filters.channel !== "all") sp.set("channel", filters.channel);
  if (filters.category) sp.set("category", filters.category);
  if (filters.tag) sp.set("tag", filters.tag);
  if (page > 1) sp.set("page", String(page));
  const q = sp.toString();
  return `/api/site/pool${q ? `?${q}` : ""}`;
}

export function MobilePoolList({ pool, filters }: { pool: PoolResponse | null; filters: TimelineFilters }) {
  const more = listPath("/all", { channel: filters.channel !== "all" ? filters.channel : null, category: filters.category, tag: filters.tag });
  const [items, setItems] = useState<FeedItemSummary[]>(() => pool?.items ?? []);
  const [page, setPage] = useState(pool?.page ?? 1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState(!pool || pool.page >= Math.min(pool.pageCount, MAX_PAGE));
  const seen = useRef(new Set((pool?.items ?? []).map((item) => item.id)));
  const sentinel = useRef<HTMLDivElement | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    if (!pool) return;
    if (page >= Math.min(pool.pageCount, MAX_PAGE)) { setDone(true); return; }
    inflight.current = true;
    setLoading(true);
    setFailed(null);
    try {
      const res = await fetch(publicPath(poolQuery(filters, page + 1)), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PoolResponse;
      const fresh = body.items.filter((item) => !seen.current.has(item.id));
      for (const item of fresh) seen.current.add(item.id);
      if (fresh.length > 0) setItems((prev) => [...prev, ...fresh]);
      setPage(body.page);
      if (body.page >= Math.min(body.pageCount, MAX_PAGE) || body.items.length === 0) setDone(true);
    } catch (error) {
      setFailed((error as Error)?.message ?? "加载失败");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [filters, page, pool]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || done) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [done, load]);

  if (!pool) {
    return (
      <div className="lg:hidden">
        <p className="py-8 text-center text-[14px] text-ink-3">收录池这一会儿读不到，</p>
        <Link to={more} className="mx-auto block w-fit text-[13px] text-accent hover:underline">去全部列表看看 →</Link>
      </div>
    );
  }
  return (
    <div className="lg:hidden">
      {/* 与精选那一页同一套行版式（左侧 48px 时间格 + 右侧卡片），不是另拼一个"简化列表"：
          站长 2026-11-04 报"全部页每条的时间没了"，根因是这里自己写了个 div，绕开了 TimelineSlot
          里的 <time>。复用同一个组件，时间格式、行距、分隔线就不会再分叉。 */}
      <ol className="mt-4 divide-y divide-line-soft lg:pt-1">
        {items.map((item: FeedItemSummary) => (
          <TimelineSlot key={item.id} at={item.timelineAt} dataKey={item.id}>
            <FeedItem item={item} filters={filters} showTags />
          </TimelineSlot>
        ))}
      </ol>
      {items.length === 0 && (
        <p className="py-8 text-center text-[14px] text-ink-3">这一筛选下还没有收录内容。</p>
      )}
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      <div className="mt-4 flex flex-col items-center gap-2 text-[12.5px] text-ink-4">
        {loading && (
          <span className="inline-flex items-center gap-2" role="status">
            <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
            正在接着取…
          </span>
        )}
        {!loading && failed && (
          <>
            <span role="alert">这一屏没取到（{failed}）</span>
            <button type="button" onClick={() => void load()} className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-2">再试一次</button>
          </>
        )}
        {!loading && !failed && done && <span>{page >= MAX_PAGE ? "最多提供 50 页；更早的日子请用上面的日历挑一天。" : "已经到底了。"}</span>}
        {!loading && !failed && !done && (
          <button type="button" onClick={() => void load()} className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-2">加载更多</button>
        )}
      </div>
    </div>
  );
}
