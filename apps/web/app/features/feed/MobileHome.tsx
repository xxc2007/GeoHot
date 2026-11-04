// 手机首页的外壳：搜索条、精选/全部 切换、日期栏与可折叠的正文。
//
// 版式来自站长 2026-11-04 给的 AIHOT 截图：最上面一条搜索框（带"搜索"按钮），下面一行品牌 +
// 两段切换 + 两个图标，再下面"当前热点"、日期栏，最后才是信息流。这里只搬版式，内容一律用本站
// 自己的数据：本站没有"模型榜"与"我的"，那两格在底部导航里换成本站真实存在的栏目（见 nav.ts）。
//
// 2026-11-04 第二轮：精选与全部不再是两个页面。首屏 loader 把两份第一页都取好，切换只改一个
// 客户端状态（并把 tab 写进地址栏），所以点下去立刻换列表，没有整页刷新、也没有二次请求。
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { FeedItemSummary, PoolResponse, TimelineFilters } from "@aihot/contracts/site";
import { withSubject } from "@aihot/industry/site";
import { Wordmark } from "../../components/Logo";
import { IconChevronDown, IconClock, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { beijingDate, beijingWeekday } from "../../lib/format";
import { listPath } from "../../lib/seo";
import { FeedItem } from "./FeedItem";
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
 * 「全部」那一段：首屏 loader 取好的第一页收录池。用与时间线同一张卡片（`FeedItem`），
 * 只是带上分类标签、并按收录时间排序——读者从精选切过来看到的是同一套排版，不用重新认界面。
 */
export function MobilePoolList({ pool, filters }: { pool: PoolResponse; filters: TimelineFilters }) {
  const more = listPath("/all", { channel: filters.channel !== "all" ? filters.channel : null, category: filters.category, tag: filters.tag });
  return (
    <div className="lg:hidden">
      <div className="mt-4 divide-y divide-line-soft">
        {pool.items.map((item: FeedItemSummary) => (
          <div key={item.id} className="py-3">
            <FeedItem item={item} filters={filters} showTags />
          </div>
        ))}
      </div>
      {pool.items.length === 0 && (
        <p className="py-8 text-center text-[14px] text-ink-3">这一筛选下还没有收录内容。</p>
      )}
      <Link
        to={more}
        className="mt-3 inline-flex text-[13px] text-accent hover:underline"
        prefetch="intent"
      >
        查看全部 {pool.total.toLocaleString("zh-CN")} 条{withSubject("动态")} →
      </Link>
    </div>
  );
}