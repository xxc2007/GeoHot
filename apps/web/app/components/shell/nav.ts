// Site navigation, one place for the desktop sidebar, the mobile tab bar and the mobile "更多" page.
import { withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import type { ReactNode } from "react";
import { publicPath } from "../../lib/public-path";
import type { Locale } from "../../lib/i18n";
import {
  IconApps, IconBolt, IconBookmark, IconChart, IconDoc, IconFlame, IconGrid, IconHeart, IconHistory, IconList, IconMessage, IconPlug,
} from "../icons";

export interface NavItem {
  to: string;
  label: string;
  /** English label for the `/en` pages (平行映射：中文页照旧读 label）。 */
  labelEn: string;
  icon: (p: { size?: number }) => ReactNode;
  /** Match the path exactly (the home page). */
  end?: boolean;
  /** Shows the unread dot while the changelog has news. */
  changelog?: boolean;
}

/** The label of a nav item in the page's language. */
export function navLabel(item: NavItem, locale: Locale): string {
  return locale === "en" ? item.labelEn : item.label;
}

/**
 * The front door as the browser must see it: `<base>/`, with the trailing slash.
 *
 * React Router resolves a root target under a basename to the *bare* base (`/geohot`), which its own
 * matcher then rejects, so `to="/"` lands a reader on the 404 route. `root.tsx` patches the History API
 * to normalise that string, but a plain anchor never goes through pushState — so every entry point that
 * renders a real `<a>` (the home nav item, the home tab, Filters' home chip) uses this instead of
 * hand-writing `publicPath("/")` at the call site.
 */
export function homeHref(): string {
  return publicPath("/");
}

/** Paths of the optional AI-only modules, so a closed module is absent from the nav, not a 404. */
const OPTIONAL_ITEMS: NavItem[] = [
  ...(FEATURES.leaderboard ? [{ to: "/leaderboard", label: "模型榜", labelEn: "Leaderboard", icon: IconChart }] : []),
  ...(FEATURES.codexResetMonitor ? [{ to: "/codex-reset", label: "Tibo重置监控", labelEn: "Tibo reset monitor", icon: IconHistory }] : []),
];

const OPTIONAL_PATHS = OPTIONAL_ITEMS.map((item) => item.to);

export const SIDEBAR: Array<{ title: string; titleEn: string; items: NavItem[] }> = [
  {
    title: "内容",
    titleEn: "Content",
    items: [
      { to: "/", label: "精选", labelEn: "Selected", icon: IconBolt, end: true },
      { to: "/all", label: `全部${withSubject("动态")}`, labelEn: "All updates", icon: IconList },
      { to: "/hot", label: "热点榜", labelEn: "Trending", icon: IconFlame },
      { to: "/daily", label: withSubject("日报"), labelEn: "Daily brief", icon: IconDoc },
      { to: "/topics", label: "主题", labelEn: "Topics", icon: IconGrid },
      { to: "/starred", label: "收藏", labelEn: "Saved", icon: IconBookmark },
    ],
  },
  // The optional AI-only modules (industry/features.ts), listed from the same flag test as MORE_PATHS.
  ...(OPTIONAL_ITEMS.length ? [{ title: "模型", titleEn: "Models", items: OPTIONAL_ITEMS }] : []),
  {
    title: "更多",
    titleEn: "More",
    items: [
      { to: "/agent", label: "Agent 接入", labelEn: "Agent access", icon: IconPlug },
      { to: "/about", label: "关于", labelEn: "About", icon: IconHeart },
      { to: "/changelog", label: "更新日志", labelEn: "Changelog", icon: IconHistory, changelog: true },
      { to: "/feedback", label: "反馈", labelEn: "Feedback", icon: IconMessage },
    ],
  },
];

export const TABBAR: NavItem[] = [
  { to: "/", label: "精选", labelEn: "Selected", icon: IconBolt, end: true },
  { to: "/hot", label: "热点", labelEn: "Trending", icon: IconFlame },
  { to: "/daily", label: "日报", labelEn: "Daily brief", icon: IconDoc },
  { to: "/topics", label: "主题", labelEn: "Topics", icon: IconGrid },
  { to: "/more", label: "更多", labelEn: "More", icon: IconApps, changelog: true },
];

/** Pages reached from the mobile "更多" tab keep that tab highlighted. Closed modules are absent. */
export const MORE_PATHS = ["/more", "/starred", ...OPTIONAL_PATHS, "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy"];

/**
 * 侧栏与标签栏共用的"这一格是不是当前页"。
 *
 * 注意：「/all」不算精选。精选与全部是两条并列的导航项（侧栏里同时存在），
 * 只有手机底部标签栏把"全部"折叠进了精选那一格 —— 那条特例在 tabIsActive 里，
 * 别写回这里，否则 /all 上侧栏会同时点亮"精选"和"全部地理动态"（2026-11-04 站长报的就是这个）。
 */
export function navIsActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  if (item.to === "/more") return MORE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (item.to === "/daily") return /^\/(daily|weekly|monthly)(\/|$)/.test(pathname);
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/**
 * 底部标签栏专用：它只有五格，没有"全部"这一格，站在 /all 上时点亮精选，
 * 否则读者会以为自己不在任何栏目里。侧栏不走这条（见 navIsActive 的注释）。
 */
export function tabIsActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to || pathname === "/all";
  return navIsActive(item, pathname);
}
