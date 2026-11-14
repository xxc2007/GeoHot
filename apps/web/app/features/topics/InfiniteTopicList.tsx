// 主题页的"一直往下拉"：服务器只渲第一页，剩下的在滚动到底部时接着取。
//
// 为什么要有它：站长 2026-11-14 再次强调"所有需要按一下下一页的设计都要换成能一直下拉"。
// 主题页当时还留着 `Pagination`（每页 20 条，读到底要按「下一页」），与 /all、精选页不一致。
//
// 与 InfiniteDayList 的差别只有一处：主题页的接续地址是 `/api/site/topics/<slug>?page=N`，
// 分页由服务端按 20 条切；其余（SSR 首屏 + 触底追加 + id 去重 + noscript 分页）完全同构。
import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { publicPath } from "../../lib/public-path";
import { DayList } from "../feed/DayList";

const MAX_PAGE = 50;

interface TopicPageBody {
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
}

export function InfiniteTopicList({ slug, initialItems, initialPage, pageCount, today, showTags = true }: {
  slug: string;
  initialItems: FeedItemSummary[];
  initialPage: number;
  pageCount: number;
  today: string;
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
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current || page >= lastPage) {
      if (page >= lastPage) setDone(true);
      return;
    }
    inflight.current = true;
    setLoading(true);
    setFailed(null);
    try {
      const next = page + 1;
      const res = await fetch(publicPath(`/api/site/topics/${encodeURIComponent(slug)}?page=${next}`), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as TopicPageBody;
      const fresh = body.items.filter((item) => !seen.current.has(item.id));
      for (const item of fresh) seen.current.add(item.id);
      if (fresh.length > 0) setItems((prev) => [...prev, ...fresh]);
      setPage(body.page);
      if (body.page >= Math.min(body.pageCount, MAX_PAGE) || body.items.length === 0) setDone(true);
    } catch (error) {
      const name = (error as Error)?.name;
      setFailed(name === "TimeoutError" || name === "AbortError" ? "这次取超时了，再滑一下试试" : ((error as Error)?.message ?? "加载失败"));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [lastPage, page, slug]);

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
      <DayList items={items} today={today} showTags={showTags} />
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
          <span>{page >= MAX_PAGE ? "最多提供 50 页；更早的内容请用主题页顶部的说明或搜索。" : "已经到底了。"}</span>
        )}
        {!loading && !failed && !done && (
          <button type="button" onClick={() => void load()} className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13px] text-ink-2 hover:border-ink-4 hover:text-ink">
            加载更多
          </button>
        )}
      </div>
    </div>
  );
}
