// 手机首页的外壳：搜索条、精选/全部 切换、日期栏与可折叠的正文。
//
// 版式来自站长 2026-11-04 给的 AIHOT 截图：最上面一条搜索框（带"搜索"按钮），下面一行品牌 +
// 两段切换 + 两个图标，再下面"当前热点"、日期栏，最后才是信息流。这里只搬版式，内容一律用本站
// 自己的数据：本站没有"模型榜"与"我的"，那两格在底部导航里换成本站真实存在的栏目（见 nav.ts）。
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Wordmark } from "../../components/Logo";
import { IconChevronDown, IconClock, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { beijingDate, beijingWeekday } from "../../lib/format";
import { SearchField } from "./Filters";

/** 精选 / 全部 两段切换：截图里的那一条，落在本站的两个列表上。 */
export function MobileFeedSwitch({ at, channel = "all" }: { at: "selected" | "all"; channel?: string }) {
  const items = [
    { key: "selected", label: "精选", to: "/", prefetch: "intent" as const },
    {
      key: "all",
      label: "全部",
      to: channel === "all" ? "/all" : `/all?channel=${channel}`,
      prefetch: "intent" as const,
    },
  ];
  return <PillTabs items={items} active={at} layoutId="mobile-feed-switch" size="sm" label="列表" />;
}

/**
 * 手机首页第一屏：搜索条 + 品牌行。
 *
 * 搜索条与 /all 页同一个组件（`SearchField variant="bar"`），走 GET `/all?q=`，所以键盘回车、
 * 屏幕阅读器的 `role="search"` 和浏览器的"后退保留输入"都跟桌面一致，不另写一套。
 */
export function MobileHomeTop({ category, channel }: { category: string | null; channel: string }) {
  return (
    <div className="lg:hidden">
      <div className="pt-1">
        <SearchField variant="bar" keep={{ category, channel: channel === "all" ? null : channel }} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <Wordmark size={20} className="text-ink" />
        <MobileFeedSwitch at="selected" channel={channel} />
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