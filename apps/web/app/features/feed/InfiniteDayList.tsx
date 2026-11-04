// 全部动态页的"一直往下拉"：服务器只渲第一页，剩下的在滚动到底部时接着取。
//
// 为什么要它：站长 2026-11-04 当面反馈"点一下才能继续阅读太麻烦"，`/all` 以前是 50 页的分页器，
// 读到第 40 条就要点「下一页」；精选页（/）早就是滚动到底自动续，两边体验不一致。
//
// 设计取舍：
//  · 首屏仍然走 SSR（页面本身可被抓取，也守住了"A 屏不空白"），这一层只负责追加；
//  · 分页链接留在 <noscript> 里，没 JS 的读者与爬虫仍然能翻页；
//  · 触底用 IntersectionObserver，rootMargin 600px 提前取，滚动时不会看到"空一拍再出内容"；
//  · 取回来的条目按 id 去重：翻页期间新收录的条目会把后面几页往后挤，重复的那几条不能画两次；
//  · 失败不吞：显示一句话 + 「再试一次」按钮，读者不必刷新整页。
import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedItemSummary, PoolResponse } from "@aihot/contracts/site";
import { publicPath } from "../../lib/public-path";
import { DayList } from "./DayList";

/** The API clamps at 50; keep the client from asking for page 51 forever. */
const MAX_PAGE = 50;

function withPage(query: string, page: number): string {
  const sp = new URLSearchParams(query);
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/api/site/pool?${s}` : "/api/site/pool";
}

export function InfiniteDayList({ initialItems, initialPage, pageCount, query, today, todayCount = null, showTags = true }: {
  initialItems: FeedItemSummary[];
  initialPage: number;
  pageCount: number;
  /** 当前这一屏的查询串（与 loader 送给 api 的那组筛选一致），不含 page。 */
  query: string;
  today: string;
  todayCount?: number | null;
  showTags?: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [page, setPage] = useState(initialPage);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const lastPage = Math.min(pageCount, MAX_PAGE);
  const [done, setDone] = useState(initialPage >= lastPage);
  const seen = useRef(new Set(initialItems.map((item) => item.id)));
  const sentinel = useRef<HTMLDivElement | null>(null);
  // 触底可能在一次滚动里连触发几次：正在取的时候第二次直接返回，请求不会并发打出去。
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    if (page >= lastPage) { setDone(true); return; }
    inflight.current = true;
    setLoading(true);
    setFailed(null);
    try {
      const next = page + 1;
      const res = await fetch(publicPath(withPage(query, next)), { headers: { accept: "application/json" } });
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
  }, [lastPage, page, query]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || done) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [done, load]);

  return (
    <div>
      <DayList items={items} today={today} todayCount={todayCount} showTags={showTags} />
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      <div className="mt-6 flex flex-col items-center gap-2 text-[12.5px] text-ink-4">
        {loading && (
          <span className="inline-flex items-center gap-2" role="status">
            <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
            正在接着取…
          </span>
        )}
        {!loading && failed && (
          <>
            <span role="alert">这一屏没取到（{failed}）</span>
            <button type="button" onClick={() => void load()} className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-2 hover:border-ink-4 hover:text-ink">
              再试一次
            </button>
          </>
        )}
        {!loading && !failed && done && (
          <span>{page >= MAX_PAGE ? "最多提供 50 页；更早的日子请用上面的日历挑一天，或者用搜索、主题页。" : "已经到底了。"}</span>
        )}
        {!loading && !failed && !done && (
          // 触底会自动取；这个按钮留给"键盘 / 屏幕阅读器 / 观察器不支持"的场合，不是唯一入口。
          <button type="button" onClick={() => void load()} className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-2 hover:border-ink-4 hover:text-ink">
            加载更多
          </button>
        )}
      </div>
    </div>
  );
}