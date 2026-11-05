// Server-side HTTP client for route loaders. The web process never touches the database;
// SSR reads the api over loopback with keep-alive, one or two requests per page.
import { data, redirect } from "react-router";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:3001";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfter: number | null;
  constructor(status: number, code: string | null, retryAfter: number | null) {
    super(`api ${status} ${code ?? ""}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * 接口回了 3xx 而调用方要自己决定怎么处理（`redirect: "manual"`）。
 * 现在只有事件的合并会用：`/api/site/stories/:id` 对已合并的事件回 308，`Location` 与正文里的
 * `mergedInto` 都给去处，页面要照着跳到新地址，而不是把跳转吞掉。
 */
export class ApiRedirect extends Error {
  readonly status: number;
  readonly location: string | null;
  readonly body: unknown;
  constructor(status: number, location: string | null, body: unknown) {
    super(`api redirect ${status}`);
    this.status = status;
    this.location = location;
    this.body = body;
  }
}

/**
 * 上一份好答案的短期底稿。
 *
 * 2026-11-06 01:4x 现场：夜档（2 个名额）一开，SSR 取时间线偶尔要 15 秒以上，`AbortSignal.timeout`
 * 一断就整页 503（读者看到的是「暂时不可用」，其实只是这一屏的数据晚了半分钟）。
 * 现在把每个 GET 上一份成功正文留最多 10 分钟：拿不到新的时候先把这份交出去，
 * 页面照常可读；真正没有底稿时才让错误继续往上走。
 */
const LAST_GOOD_TTL_MS = 10 * 60_000;
const LAST_GOOD_MAX = 64;
const lastGood = new Map<string, { at: number; body: unknown }>();

function rememberGood(path: string, body: unknown): void {
  if (lastGood.size >= LAST_GOOD_MAX && !lastGood.has(path)) {
    const oldest = [...lastGood.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) lastGood.delete(oldest[0]);
  }
  lastGood.set(path, { at: Date.now(), body });
}

function lastGoodFor<T>(path: string): T | null {
  const hit = lastGood.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > LAST_GOOD_TTL_MS) {
    lastGood.delete(path);
    return null;
  }
  return hit.body as T;
}

export async function apiGet<T>(
  path: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; responseHeaders?: Headers; redirect?: RequestRedirect },
): Promise<T> {
  try {
    const body = await apiGetFresh<T>(path, init);
    rememberGood(path, body);
    return body;
  } catch (error) {
    // 只有「读不到 / 超时 / 上游 5xx」才用底稿；404、重定向、4xx 是页面自己的答案，照原样返回。
    const stale = !(error instanceof ApiRedirect) && (error instanceof ApiError ? error.status >= 500 : true) ? lastGoodFor<T>(path) : null;
    if (stale !== null) return stale;
    throw error;
  }
}

/**
 * 每一屏数据的等待预算。
 *
 * 2026-11-06 02:2x 现场：夜档开着、分析在跑，首页 11 秒才出——15 秒的兜底等于「读者先干等」。 
 * 首屏真正要紧的是那一条时间线（决定这一屏说什么），其余是配菜：收录池、日历、热点、
 * 主题计数都只影响侧栏与筛选条，晚半分钟不如立刻用上一份。预算按路径给，底稿兜底照旧。
 */
// 2026-11-06 复核：8 秒的预算本身就是「读者先干等 8 秒」的许可；首页正常 0.4–1.6 秒、
// 忙时 2–4 秒。首屏 3.5 秒、配菜 1.5 秒，超时交给上一份好答案（lastGood）。
const SSR_BUDGET_MS = 3_500;
const SSR_AUX_BUDGET_MS = 1_500;
const AUX_PATHS = ["/api/site/pool", "/api/site/calendar", "/api/site/hot", "/api/site/topics"];

function ssrBudgetMs(path: string): number {
  return AUX_PATHS.some((prefix) => path.startsWith(prefix)) ? SSR_AUX_BUDGET_MS : SSR_BUDGET_MS;
}

async function apiGetFresh<T>(
  path: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; responseHeaders?: Headers; redirect?: RequestRedirect },
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json", "x-aihot-ssr": "1", ...init?.headers },
    redirect: init?.redirect ?? "follow",
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(ssrBudgetMs(path))])
      : AbortSignal.timeout(ssrBudgetMs(path)),
  });
  if (res.status >= 300 && res.status < 400) {
    // 只有明确要 manual 的调用才会走到这里；默认还是浏览器那条跟随跳转的路。
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // 没有正文
    }
    throw new ApiRedirect(res.status, res.headers.get("location"), body);
  }
  if (!res.ok) {
    let code: string | null = null;
    try {
      code = ((await res.json()) as { code?: string }).code ?? null;
    } catch {
      // not JSON
    }
    const retry = res.headers.get("retry-after");
    throw new ApiError(res.status, code, retry ? Number(retry) : null);
  }
  res.headers.forEach((value, name) => init?.responseHeaders?.set(name, value));
  // 200 但空体/HTML（代理把上游错误页原样回给我们）不该变成未捕获的 SyntaxError ——
  // 那会被上层兜成 503，把「接口返回了垃圾」误报成「接口不可用」。
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(502, "bad_json", null);
  }
}

/** Maps API failures to route responses: real 404s, search-busy page, otherwise 503. */
export async function loadOr404<T>(
  path: string,
  opts: { busyRedirect?: string; responseHeaders?: Headers; signal?: AbortSignal; redirect?: RequestRedirect } = {},
): Promise<T> {
  try {
    return await apiGet<T>(path, { responseHeaders: opts.responseHeaders, signal: opts.signal, redirect: opts.redirect });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    // 跳转不是故障：调用方（要 manual 的那一个）自己决定跳去哪。
    if (error instanceof ApiRedirect) throw error;
    if (error instanceof ApiError) {
      if (error.status === 404) throw data({ message: "not_found" }, { status: 404 });
      // 只有「搜索排队」这一种 503 才跳「搜索有点忙」：以前任何 503 都跳过去，于是列表本身
      // 读不出来时，读者被送到一个和搜索毫无关系的页面（`site.ts` 的两个 503 出口共用同一个
      // code 是那条 bug 的根；现在它们分别叫 search_busy 与 read_busy）。
      if (error.status === 503 && error.code === "search_busy" && opts.busyRedirect) throw redirect(opts.busyRedirect);
      if (error.status === 400) throw data({ message: "bad_request" }, { status: 400 });
    }
    throw data({ message: "unavailable" }, { status: 503 });
  }
}

export function queryString(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Cache headers for a page of selected items: shared caches keep it at most `maxSeconds`, and never
 * past the next pending release in its scope, the same absolute deadline the api gives a proxy or
 * CDN in front. No stale-while-revalidate: a released item must not wait behind a stale copy.
 */
export function releaseBoundCache(refreshAt: string | null, maxSeconds: number, now = Date.now(), upstream?: Headers): Record<string, string> {
  let deadline = Math.floor(now / 1000) + maxSeconds;
  if (refreshAt) deadline = Math.min(deadline, Math.floor(Date.parse(refreshAt) / 1000));
  const sourceDeadline = upstream?.get("X-Accel-Expires");
  if (sourceDeadline?.startsWith("@")) deadline = Math.min(deadline, Number(sourceDeadline.slice(1)));
  if (sourceDeadline === "0" || /(?:no-cache|no-store)/i.test(upstream?.get("Cache-Control") ?? "")) deadline = Math.floor(now / 1000);
  const seconds = Math.max(0, Math.floor(deadline - now / 1000));
  return {
    "Cache-Control": seconds > 0 ? `public, max-age=0, s-maxage=${seconds}` : "no-cache",
    "X-Accel-Expires": seconds > 0 ? `@${deadline}` : "0",
  };
}
