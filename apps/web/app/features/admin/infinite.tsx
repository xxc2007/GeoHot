// 后台列表的「一直往下拉」：站长 2026-11-14 的原话是「把所有需要按一下下一页的设计全部升级为
// 可以一直下拉的设计」。三个后台列表（审计、反馈、信源）都长成 `{page, rows, hasMore}` 这一副样子，
// 所以这里只写一次：SSR 交出第一页，滚到底再由浏览器去要下一页，追加到同一个列表上。
//
// 用 `appPath()` 拼地址，部署在 `/geohot` 前缀下时也不会指错（同源请求会自动带上会话 cookie）。
import { useCallback, useEffect, useRef, useState } from "react";
import { appPath } from "../../lib/public-path";

export interface AdminPage<T> {
  page: number;
  rows: T[];
  hasMore: boolean;
}

export function useInfiniteRows<T>(path: string, first: AdminPage<T>, query: string) {
  const [rows, setRows] = useState<T[]>(first.rows);
  const [page, setPage] = useState(first.page);
  const [hasMore, setHasMore] = useState(first.hasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const loadMore = useCallback(() => {
    if (busy.current || !hasMore) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams(query);
    params.set("page", String(page + 1));
    fetch(appPath(`${path}?${params}`), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AdminPage<T>>;
      })
      .then((body) => {
        setRows((prev) => [...prev, ...body.rows]);
        setPage(body.page);
        setHasMore(body.hasMore);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "读取失败"))
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, [hasMore, page, path, query]);

  return { rows, page, hasMore, loading, error, loadMore };
}

/**
 * 滚到底自动续读的那一条。`rootMargin` 提前 600px 触发，读者还没看到底就已经在取了；
 * 取失败时给一颗「再试一次」，不做无限重试（后台每次请求都要过会话与审计）。
 */
export function LoadMore({
  hasMore,
  loading,
  error,
  onLoad,
  empty,
}: {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  empty?: string;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoad();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoad]);

  if (!hasMore && !loading && !error) {
    return empty ? <p className="mt-4 text-center text-[12.5px] text-ink-3">{empty}</p> : null;
  }

  return (
    <div ref={sentinel} className="mt-4 flex flex-col items-center gap-2 text-[13px] text-ink-3" aria-live="polite">
      {error ? (
        <>
          <span>这一页没读到（{error}）</span>
          <button type="button" onClick={onLoad} className="rounded-control px-3 py-1 ring-1 ring-line hover:text-ink">
            再试一次
          </button>
        </>
      ) : (
        <span>{loading ? "正在往下取…" : "继续向下滚动"}</span>
      )}
    </div>
  );
}
