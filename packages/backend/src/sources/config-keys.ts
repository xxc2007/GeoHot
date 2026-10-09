// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource, plus the date offset every
// entrance now reads a zone-less timestamp in (sources/dates.ts).
const COLLECTED = ["_aihot", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent", "publishedAtUtcOffset"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories", "headers"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "requireBoolean", "minNumeric",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: ["_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType"],
  mp_account: ["wxid", "ghid", "nickname"],
  // An external source is only written by the ingest endpoint, which reads the offset a report's
  // zone-less publishedAt is to be taken in.
  external: ["publishedAtUtcOffset"],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  // intervalMinutesMax is the ceiling adaptIntervals may not poll above; intervalMinutesLocked keeps
  // the source at the interval an operator set, whatever its recent volume.
  _aihot: ["initialBackfillLimit", "initialBackfillMonths", "intervalMinutesMax", "intervalMinutesLocked"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches", "requireTitleMarkers"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  adapter: ["mimo_home"],
  parseMode: ["html", "markdown", "docusaurus_changelog"],
};

/**
 * 这些规则项在采集里是被当数组用的（`.map` / `.some`）。写成字符串或对象时，采集那一轮抛
 * TypeError，后台看到的是 500 而不是"这一项写错了"——预览走的是同一条流水线，所以同一个写法
 * 会让"试抓一次"也打不开。所以在门口按形状拒掉，与上面 VALUES 的枚举值同一层。
 * 值是 `null` / 缺省不算写错：读它们的地方一律 `?? []`。
 */
const LIST_KEYS = ["allowUrlPrefixes", "denyUrlPrefixes", "allowCategories", "denyCategories"];
const NESTED_LISTS: Record<string, string[]> = {
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches", "requireTitleMarkers"],
};
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (value !== null && value !== undefined && LIST_KEYS.includes(key) && !isStringList(value)) out.push(`${key}（要字符串数组）`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) {
        if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
        else if (NESTED_LISTS[key]?.includes(sub) && !isStringList((value as Record<string, unknown>)[sub])) out.push(`${key}.${sub}（要字符串数组）`);
      }
    }
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}
