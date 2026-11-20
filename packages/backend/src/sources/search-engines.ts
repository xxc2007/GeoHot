// Official search APIs used by source discovery. Every adapter is server-side only; the API key
// never reaches a page, a log line or a stored row. HTML result pages (Bing/DuckDuckGo/Baidu SERP)
// are deliberately not implemented: their terms do not grant automated scraping, and a robots.txt
// Allow is not a licence. The catalog exposes that boundary instead of hiding it.
//
// Keys are read from GEOHOT_SEARCH_<ENGINE>_KEY first, then the provider's conventional name
// (EXA_API_KEY, TAVILY_API_KEY, ...), so a search key can live beside a model key without collision.
import { guardedFetch } from "../lib/http-fetch.ts";

export interface SearchHit {
  engine: string;
  rank: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface EngineFailure {
  engine: string;
  error: string;
}

export interface SearchOptions {
  maxResults?: number;
  lang?: "zh" | "en";
}

interface EngineDefinition {
  id: string;
  label: string;
  keyEnv: string[];
  keyless?: boolean;
  note?: string;
  search(query: string, key: string, opts: Required<SearchOptions>): Promise<SearchHit[]>;
}

const clean = (value: unknown, max = 400): string => String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const asDate = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;
};
const numResults = (opts: Required<SearchOptions>) => Math.min(Math.max(opts.maxResults ?? 10, 1), 20);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function requestJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Record<string, any>> {
  const res = await guardedFetch(url, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent": "GEOHOT-source-discovery/1.0 (+https://xxc2007.me/geohot/about)",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    timeoutMs: init.timeoutMs ?? 20_000,
    maxBytes: 2_000_000,
  });
  if (res.status < 200 || res.status > 299) throw new HttpError(res.status, `HTTP ${res.status}`);
  const text = res.text();
  try { return JSON.parse(text) as Record<string, any>; } catch { throw new Error("response is not JSON"); }
}

/** JSON body first, then SSE `data:` frames (Zhihu/Aliyun MCP endpoints use both shapes). */
function parseMcp(text: string): Record<string, any> | null {
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" ? parsed : null; } catch { /* SSE */ }
  const payloads: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""));
    if (lines.length) payloads.push(lines.join("\n"));
  }
  if (!payloads.length) payloads.push(...text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")));
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch { /* next frame */ }
  }
  return null;
}

async function mcpCall(url: string, key: string, tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await guardedFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "GEOHOT-source-discovery/1.0 (+https://xxc2007.me/geohot/about)",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    timeoutMs: 25_000,
    maxBytes: 2_000_000,
  });
  if (res.status < 200 || res.status > 299) throw new HttpError(res.status, `HTTP ${res.status}`);
  const envelope = parseMcp(res.text());
  if (!envelope) throw new Error("MCP response is not JSON or SSE");
  if (envelope.error) throw new Error(`MCP error: ${clean(envelope.error.message ?? envelope.error.code, 160)}`);
  const result = envelope.result;
  if (!result || typeof result !== "object") throw new Error("MCP result missing");
  if (result.isError) throw new Error(`MCP tool error: ${clean(result.content?.[0]?.text, 160)}`);
  return result as Record<string, any>;
}

const hits = (engine: string, rows: Array<Record<string, any>>, map: (row: Record<string, any>) => { title?: unknown; url?: unknown; snippet?: unknown; publishedAt?: unknown }, limit: number): SearchHit[] =>
  rows
    .map((row) => map(row))
    .filter((row) => typeof row.url === "string" && /^https?:\/\//i.test(row.url))
    .slice(0, limit)
    .map((row, index) => ({
      engine,
      rank: index + 1,
      title: clean(row.title, 200),
      url: String(row.url),
      snippet: clean(row.snippet, 400),
      ...(asDate(row.publishedAt) ? { publishedAt: asDate(row.publishedAt)! } : {}),
    }));

const ENGINES: EngineDefinition[] = [
  {
    id: "exa", label: "Exa", keyEnv: ["GEOHOT_SEARCH_EXA_KEY", "EXA_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://api.exa.ai/search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: { query, type: "auto", numResults: numResults(opts), contents: { highlights: { highlightsPerUrl: 1 } } },
      });
      return hits("exa", data.results ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.highlights?.find((x: unknown) => typeof x === "string" && x.trim()) ?? "", publishedAt: r.publishedDate }), numResults(opts));
    },
  },
  {
    id: "tavily", label: "Tavily", keyEnv: ["GEOHOT_SEARCH_TAVILY_KEY", "TAVILY_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://api.tavily.com/search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: { query, max_results: numResults(opts), search_depth: "basic" },
      });
      return hits("tavily", data.results ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.content }), numResults(opts));
    },
  },
  {
    id: "firecrawl", label: "Firecrawl", keyEnv: ["GEOHOT_SEARCH_FIRECRAWL_KEY", "FIRECRAWL_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: { query, limit: Math.min(numResults(opts), 10) },
      });
      return hits("firecrawl", data.data?.web ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.description }), numResults(opts));
    },
  },
  {
    id: "serpbase", label: "SerpBase · Google", keyEnv: ["GEOHOT_SEARCH_SERPBASE_KEY", "SERPBASE_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://api.serpbase.dev/google/search", {
        method: "POST",
        headers: { "x-api-key": key },
        body: { q: query, hl: opts.lang === "zh" ? "zh-cn" : "en", gl: opts.lang === "zh" ? "cn" : "us", page: 1 },
      });
      if (data.status !== 0) throw new Error(`SerpBase status ${data.status}`);
      return hits("serpbase", data.organic ?? [], (r) => ({ title: r.title, url: r.link, snippet: r.snippet, publishedAt: r.published_at ?? r.date }), numResults(opts));
    },
  },
  {
    id: "serply", label: "Serply · Google", keyEnv: ["GEOHOT_SEARCH_SERPLY_KEY", "SERPLY_API_KEY"],
    async search(query, key, opts) {
      const params = new URLSearchParams({ q: query, num: String(Math.min(numResults(opts), 10)), hl: opts.lang === "zh" ? "zh-cn" : "en", gl: opts.lang === "zh" ? "cn" : "us" });
      const data = await requestJson(`https://api.serply.io/v1/search?${params}`, { headers: { "x-api-key": key } });
      return hits("serply", data.results ?? [], (r) => ({ title: r.title, url: r.link, snippet: r.description }), numResults(opts));
    },
  },
  {
    id: "you", label: "You.com", keyEnv: ["GEOHOT_SEARCH_YOU_KEY", "YOUCOM_API_KEY", "YDC_API_KEY"],
    async search(query, key, opts) {
      const params = new URLSearchParams({ query, count: String(numResults(opts)) });
      const data = await requestJson(`https://ydc-index.io/v1/search?${params}`, { headers: { "x-api-key": key } });
      return hits("you", data.results?.web ?? [], (r) => ({ title: r.title, url: r.url, snippet: Array.isArray(r.snippets) ? r.snippets.join(" ") : r.description }), numResults(opts));
    },
  },
  {
    id: "baidu", label: "百度千帆 · AI 搜索", keyEnv: ["GEOHOT_SEARCH_BAIDU_KEY", "BAIDU_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://qianfan.baidubce.com/v2/ai_search/web_search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-appbuilder-from": "geohot" },
        body: { messages: [{ role: "user", content: query }], search_source: "baidu_search_v2", resource_type_filter: [{ type: "web", top_k: numResults(opts) }] },
      });
      return hits("baidu", data.references ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.content, publishedAt: r.date }), numResults(opts));
    },
  },
  {
    id: "aliyun", label: "阿里云百炼 · EnhancedSearch", keyEnv: ["GEOHOT_SEARCH_DASHSCOPE_KEY", "DASHSCOPE_API_KEY"],
    async search(query, key, opts) {
      const result = await mcpCall("https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp", key, "search_pro", { query: query.slice(0, 500) });
      const text = result.content?.find((c: Record<string, any>) => c?.type === "text" && typeof c.text === "string")?.text;
      if (!text) return [];
      let inner: Record<string, any>;
      try { inner = JSON.parse(text); } catch { throw new Error("Aliyun inner content is not JSON"); }
      return hits("aliyun", inner.pages ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.snippet, publishedAt: r.published_at }), numResults(opts));
    },
  },
  {
    id: "doubao", label: "豆包 · Web Search", keyEnv: ["GEOHOT_SEARCH_DOUBAO_KEY", "DOUBAO_SEARCH_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://open.feedcoopapi.com/search_api/web_search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-traffic-tag": "geohot-source-discovery" },
        body: { Query: query.slice(0, 100), SearchType: "web", Count: numResults(opts), NeedSummary: true, Filter: { NeedUrl: true } },
      });
      const err = data.ResponseMetadata?.Error;
      if (err) throw new Error(`Doubao ${err.Code ?? ""} ${clean(err.Message, 120)}`);
      return hits("doubao", data.Result?.WebResults ?? [], (r) => ({ title: r.Title, url: r.Url, snippet: r.Summary ?? r.Content ?? r.Snippet, publishedAt: r.PublishTime }), numResults(opts));
    },
  },
  {
    id: "tinyfish", label: "TinyFish", keyEnv: ["GEOHOT_SEARCH_TINYFISH_KEY", "TINYFISH_API_KEY"],
    async search(query, key, opts) {
      const params = new URLSearchParams({ query });
      const data = await requestJson(`https://api.search.tinyfish.ai?${params}`, { headers: { "x-api-key": key } });
      return hits("tinyfish", data.results ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.snippet }), numResults(opts));
    },
  },
  {
    id: "jina", label: "Jina Search", keyEnv: ["GEOHOT_SEARCH_JINA_KEY", "JINA_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson(`https://s.jina.ai/?${new URLSearchParams({ q: query })}`, { headers: { authorization: `Bearer ${key}` } });
      return hits("jina", data.data ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.description }), numResults(opts));
    },
  },
  {
    id: "keenable", label: "Keenable", keyEnv: ["GEOHOT_SEARCH_KEENABLE_KEY", "KEENABLE_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://api.keenable.ai/v1/search", {
        method: "POST",
        headers: { "x-api-key": key },
        body: { query, mode: "realtime" },
      });
      return hits("keenable", data.results ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? r.description, publishedAt: r.published_at }), numResults(opts));
    },
  },
  {
    id: "deepseek-tools", label: "DeepSeek · Tools Search", keyEnv: ["GEOHOT_SEARCH_DEEPSEEK_KEY", "DEEPSEEK_TOOLS_API_KEY", "DEEPSEEK_API_KEY"],
    async search(query, key, opts) {
      const data = await requestJson("https://api.deepseek.com/v1/tools/search", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: { query, count: numResults(opts) },
      });
      return hits("deepseek-tools", data.results ?? [], (r) => ({ title: r.title, url: r.url, snippet: [r.summary, r.snippet].filter(Boolean).join(" "), publishedAt: r.date }), numResults(opts));
    },
  },
  {
    id: "anysearch", label: "AnySearch · AI", keyEnv: ["GEOHOT_SEARCH_ANYSEARCH_KEY", "ANYSEARCH_API_KEY"], keyless: true,
    async search(query, key, opts) {
      const data = await requestJson("https://api.anysearch.com/v1/search", {
        method: "POST",
        ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
        body: { query, max_results: numResults(opts) },
      });
      if (data.code !== 0) throw new Error(`AnySearch code ${data.code}`);
      return hits("anysearch", data.data?.results ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.snippet }), numResults(opts));
    },
  },
  {
    id: "searxng", label: "SearXNG · 元搜索", keyEnv: ["GEOHOT_SEARCH_SEARXNG_KEY", "SEARXNG_BEARER_TOKEN"], keyless: true,
    note: "公共实例；可用 GEOHOT_SEARCH_SEARXNG_INSTANCES 覆盖实例清单",
    async search(query, key, opts) {
      const instances = (process.env.GEOHOT_SEARCH_SEARXNG_INSTANCES ?? [
        "https://search.lumy.live",
        "https://opnxng.com",
        "https://priv.au",
        "https://searx.be",
        "https://search.inetol.net",
      ].join(",")).split(",").map((x) => x.trim()).filter(Boolean);
      const errors: string[] = [];
      for (const base of instances) {
        try {
          const data = await requestJson(`${base.replace(/\/$/, "")}/search?${new URLSearchParams({ q: query, format: "json" })}`, {
            headers: key ? { authorization: `Bearer ${key}` } : {},
            timeoutMs: 10_000,
          });
          if (!Array.isArray(data.results)) throw new Error("not a SearXNG JSON response");
          const rows = hits("searxng", data.results, (r) => ({ title: r.title, url: r.url, snippet: r.content }), numResults(opts));
          if (rows.length) return rows;
          errors.push(`${base}: 0 results`);
        } catch (error) { errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      throw new Error(`all SearXNG instances failed: ${errors.join(", ").slice(0, 240)}`);
    },
  },
  {
    id: "zhihu", label: "知乎 · 全网搜索", keyEnv: ["GEOHOT_SEARCH_ZHIHU_KEY", "ZHIHU_API_KEY"],
    async search(query, key, opts) {
      const result = await mcpCall("https://developer.zhihu.com/api/mcp/v1", key, "global_search", { query: query.slice(0, 100), count: Math.min(numResults(opts), 20), search_db: "all" });
      const text = result.content?.find((c: Record<string, any>) => c?.type === "text" && typeof c.text === "string")?.text;
      if (!text) return [];
      let inner: Record<string, any>;
      try { inner = JSON.parse(text); } catch { throw new Error("Zhihu inner content is not JSON"); }
      if (typeof inner.code === "number" && inner.code !== 0) throw new Error(`Zhihu code ${inner.code}`);
      return hits("zhihu", inner.data?.items ?? [], (r) => ({ title: r.title, url: r.url, snippet: r.summary, publishedAt: Number.isFinite(r.edit_time) && r.edit_time > 0 ? new Date(r.edit_time * 1000).toISOString() : undefined }), numResults(opts));
    },
  },
];

/** Engines that are registered in the DSH pack but deliberately not wired here. */
export const UNSUPPORTED_ENGINES: Array<{ id: string; label: string; why: string }> = [
  { id: "bing", label: "Bing", why: "HTML 结果页抓取不获授权；没有官方免费搜索 API" },
  { id: "ddg", label: "DuckDuckGo", why: "HTML 结果页抓取不获授权；没有官方搜索 API" },
  { id: "ddg-lite", label: "DuckDuckGo Lite", why: "同上" },
  { id: "baidu-html", label: "百度网页", why: "HTML 抓取；改用百度千帆官方 API" },
  { id: "so360", label: "360 搜索", why: "HTML 抓取；无官方 API" },
  { id: "sogou", label: "搜狗", why: "HTML 抓取；无官方 API" },
  { id: "wechat", label: "微信文章", why: "HTML 抓取；无官方 API" },
  { id: "toutiao", label: "今日头条", why: "HTML 抓取；无官方 API" },
  { id: "degoog", label: "Degoog", why: "需要自建实例；未配置实例地址" },
  { id: "parallel", label: "Parallel", why: "未配置 PARALLEL_API_KEY；匿名 MCP 未接入" },
  { id: "brave", label: "Brave", why: "未配置 BRAVE_API_KEY" },
  { id: "zhipu", label: "智谱", why: "未配置 ZHIPU_API_KEY" },
  { id: "perplexity", label: "Perplexity", why: "未配置 PERPLEXITY_API_KEY" },
  { id: "outcrawl", label: "Outcrawl", why: "未配置 OUTCRAWL_API_KEY" },
  { id: "kimi", label: "Kimi", why: "未配置 MOONSHOT_API_KEY" },
  { id: "google", label: "Google CSE", why: "未配置 GOOGLE_CSE_API_KEY 与 googleCseId" },
  { id: "metaso", label: "秘塔", why: "未配置 METASO_API_KEY" },
  { id: "yandex", label: "Yandex", why: "未配置 YANDEX_API_KEY 与 yandexFolderId" },
  { id: "yuanbao", label: "腾讯元宝", why: "未配置 TENCENTCLOUD_WSA_APIKEY" },
  { id: "specstream", label: "SpecStream", why: "未配置 SPECSTREAM_API_KEY" },
  { id: "openai", label: "OpenAI", why: "模型内置搜索，按次计费；不进入信源发现" },
  { id: "gemini", label: "Gemini", why: "模型内置搜索，按次计费；不进入信源发现" },
  { id: "claude", label: "Claude", why: "模型内置搜索，按次计费；不进入信源发现" },
  { id: "agy", label: "Antigravity", why: "需要本机 agy CLI，服务器没有" },
];

export function engineKey(id: string): { key: string; names: string[] } {
  const def = ENGINES.find((engine) => engine.id === id);
  if (!def) return { key: "", names: [] };
  const key = def.keyEnv.map((name) => process.env[name]).find((value) => typeof value === "string" && value.trim()) ?? "";
  return { key, names: def.keyEnv };
}

export function engineCatalog(): Array<{ id: string; label: string; configured: boolean; keyless: boolean; note?: string }> {
  return ENGINES.map((engine) => ({
    id: engine.id,
    label: engine.label,
    configured: Boolean(engine.keyless || engineKey(engine.id).key),
    keyless: Boolean(engine.keyless),
    ...(engine.note ? { note: engine.note } : {}),
  }));
}

export function resolveEngineIds(requested: string[] | undefined): string[] {
  const known = new Set(ENGINES.map((engine) => engine.id));
  const picked = (requested ?? []).filter((id) => known.has(id));
  return picked.length ? picked : ENGINES.filter((engine) => engine.keyless || engineKey(engine.id).key).map((engine) => engine.id);
}

/** Run selected engines in parallel (bounded), preserving per-engine failure as evidence. */
export async function searchEngines(query: string, requested: string[] | undefined, opts: SearchOptions = {}): Promise<{ hits: SearchHit[]; failures: EngineFailure[]; used: string[] }> {
  const ids = resolveEngineIds(requested);
  const settings: Required<SearchOptions> = { maxResults: opts.maxResults ?? 10, lang: opts.lang ?? (/[\u4e00-\u9fff]/.test(query) ? "zh" : "en") };
  const hitsOut: SearchHit[] = [];
  const failures: EngineFailure[] = [];
  const used: string[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const def = ENGINES.find((engine) => engine.id === id);
      if (!def) continue;
      const { key } = engineKey(id);
      if (!key && !def.keyless) { failures.push({ engine: id, error: "missing API key" }); continue; }
      used.push(id);
      try {
        const rows = await def.search(query, key, settings);
        hitsOut.push(...rows);
      } catch (error) {
        const message = error instanceof HttpError && error.status === 429 ? "rate limited (HTTP 429)" : error instanceof Error ? error.message : String(error);
        failures.push({ engine: id, error: message.slice(0, 200) });
      }
    }
  });
  await Promise.all(workers);
  return { hits: hitsOut, failures, used };
}
