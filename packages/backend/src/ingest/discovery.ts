// 判定一个候选地址值不值得进注册表：不是「能解析」就算，而是「解析出来还有活的条目」。
// 这一层刻意不 import 任何东西（不碰 XML、不碰网络、不碰库）：CLI 拿它做门槛，
// 测试直接调用它，两边看到的是同一套数字。feed 解析本身仍走 sources/rss.ts，
// 这里只接收它吐出来的条目。
//
// 门槛与理由：5 条是「这是一份在更新的订阅，不是一篇随手生成的一次性 feed」；
// 30 天与备用池复核同一量级（docs/source-reserve-policy.md 的「最近七天验证」更严，
// 但那是每日复核，不是首次发现）。新迁移里没有任何数据，阈值只活在这个文件。

export const DISCOVERY_MIN_ITEMS = 5;
export const DISCOVERY_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

export type DiscoveryReason = "ok" | "http" | "too-few-items" | "no-dated-items" | "stale";

/** feed 解析器能给出的最少形状：日期是判据，其余字段与门槛无关。 */
export interface DiscoveryItem {
  publishedAt?: Date | null;
}

export interface DiscoveryVerdict {
  ok: boolean;
  reason: DiscoveryReason;
  /** 解析出来的条目总数（没有日期的也算条数，条数是「这份订阅还在出东西」的证据）。 */
  itemCount: number;
  /** 其中带有效日期的条数；0 表示这份 feed 最新到什么程度无从判断。 */
  datedCount: number;
  latest: Date | null;
  /** 最新一条距今多少天，保留一位小数；无日期时为 null。 */
  ageDays: number | null;
  httpStatus: number | null;
}

/**
 * 唯一判据。`httpStatus` 给 null 表示还没拿到应答（例如只解析了别处的返回值）；
 * 给了就必须是 2xx，一份 404 页面里碰巧出现的条目不能当候选。
 */
export function evaluateCandidate(input: { items: readonly DiscoveryItem[]; httpStatus: number | null; now: Date }): DiscoveryVerdict {
  const { items, httpStatus, now } = input;
  const dated = items
    .map((item) => item.publishedAt)
    .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
  const latest = dated.reduce<Date | null>((newest, value) => (newest === null || value.getTime() > newest.getTime() ? value : newest), null);
  const ageDays = latest === null ? null : Math.round(((now.getTime() - latest.getTime()) / DAY_MS) * 10) / 10;
  const verdict = (ok: boolean, reason: DiscoveryReason): DiscoveryVerdict => ({
    ok,
    reason,
    itemCount: items.length,
    datedCount: dated.length,
    latest,
    ageDays,
    httpStatus,
  });

  if (httpStatus !== null && (httpStatus < 200 || httpStatus > 299)) return verdict(false, "http");
  if (items.length < DISCOVERY_MIN_ITEMS) return verdict(false, "too-few-items");
  // 日期缺失不是「旧」，是「不知道」——不知道就不收，和 31 天一样挡住。
  if (latest === null || ageDays === null) return verdict(false, "no-dated-items");
  if (ageDays > DISCOVERY_MAX_AGE_DAYS) return verdict(false, "stale");
  return verdict(true, "ok");
}

const ymd = (value: Date): string => value.toISOString().slice(0, 10);

/** 写进 `sources.review_note` 的那一句话：条数、最新日期、HTTP 状态，审核的人不用再跑一遍。 */
export function formatReviewNote(verdict: DiscoveryVerdict): string {
  const http = verdict.httpStatus === null ? "HTTP 未记录" : `HTTP ${verdict.httpStatus}`;
  const latest = verdict.latest === null ? "无可用日期" : `${ymd(verdict.latest)}（${verdict.ageDays} 天前）`;
  if (verdict.ok) return `通过：${verdict.itemCount} 条；最新 ${latest}；${http}`;
  const why: Record<Exclude<DiscoveryReason, "ok">, string> = {
    http: "应答不是 2xx",
    "too-few-items": `不足 ${DISCOVERY_MIN_ITEMS} 条`,
    "no-dated-items": "条目没有日期，新鲜度无法判断",
    stale: `最新一条超过 ${DISCOVERY_MAX_AGE_DAYS} 天`,
  };
  return `未通过：${verdict.itemCount} 条；${latest}；${http}；${why[verdict.reason as Exclude<DiscoveryReason, "ok">] ?? verdict.reason}`;
}

/** `discovered_via` 的取值：人工给的列表是 `url:`，搜索端点找到的是 `search:`。 */
export function discoveredVia(origin: "url" | "search", host: string): string {
  return `${origin}:${host}`;
}

/** 站点的 host，去掉 `www.` 并转小写：`https://www.Example.com/a` 与 `https://example.com/b` 是同一个站。 */
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 用于去重的地址键：host 小写、去掉末尾斜杠、丢掉 fragment，查询串保留（不少 feed 靠它区分栏目）。 */
export function addressKey(address: string): string {
  try {
    const url = new URL(address);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return address.toLowerCase().trim();
  }
}

/** 候选清单文件的一行一条：空行与 `#` 注释跳过，没写协议的补 https，重复的地址只留第一条。 */
export function candidateLines(text: string, limit = 5000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const address = /^https?:\/\//i.test(line) ? line : `https://${line}`;
    const key = addressKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
    if (out.length >= limit) break;
  }
  return out;
}

/** `<link>` 标签的属性表。只读 href/rel/type，大小写不敏感。 */
function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? "").replaceAll("&amp;", "&");
  }
  return out;
}

/**
 * 页面里声明的订阅地址：`<link rel="alternate" type="application/rss+xml" href="…">`（Atom 同理）。
 * 这是 HTML 里的一个标签，不是 XML 文档，所以不引入解析器；相对地址按页面自身地址解析。
 */
export function feedLinksFromHtml(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributesOf(tag[0]);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    const type = (attrs.type ?? "").toLowerCase();
    if (!rel.includes("alternate")) continue;
    if (!/^application\/(rss|atom|rdf)\+xml$/.test(type)) continue;
    const href = attrs.href?.trim();
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") found.add(url.toString());
    } catch {
      // 一个拼错的 href 不该让整页作废。
    }
  }
  return [...found];
}

const ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|mp3|pdf)(?:[?#]|$)/i;

/** 搜索结果里能当候选的地址：JSON 里任何 http(s) 字符串，去掉静态资源。 */
export function candidateUrlsFromSearch(payload: unknown, limit = 200): string[] {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (out.size >= limit || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (!/^https?:\/\//i.test(node) || ASSET.test(node)) return;
      out.add(node.trim());
      return;
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        visit(value);
        if (out.size >= limit) return;
      }
      return;
    }
    if (typeof node !== "object") return;
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value);
      if (out.size >= limit) return;
    }
  };
  visit(payload);
  return [...out];
}
