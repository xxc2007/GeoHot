// A source's display name in one reader language.
//
// `sources.name_en` (migration 0128) is the only English name the database has, and it is empty for
// almost every source (industry/sources.json carries no nameEn). The English edition must not print a
// Chinese publisher name on a card; when there is no English name, the original host is the honest
// English identifier (`theguardian.com` instead of `The Guardian · 环境`). Chinese pages keep `name`.
import { hasChineseCopy } from "@aihot/contracts/copy";
import type { SiteLang } from "@aihot/contracts/site";

/** Host without `www.`, or "" when the address cannot be parsed. */
export function hostOfUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function sourceNameFor(
  lang: SiteLang,
  name: string,
  nameEn?: string | null,
  url?: string | null,
): string {
  if (lang !== "en") return name;
  const english = nameEn?.trim();
  if (english) return english;
  // 原名本来就没有汉字（USGS、Nature…）就直接用；有汉字的才落到域名。
  if (!hasChineseCopy(name)) return name;
  return hostOfUrl(url) || name;
}