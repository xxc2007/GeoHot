// Site navigation, one place for the desktop sidebar, the mobile tab bar and the mobile "更多" page.
import { withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import type { ReactNode } from "react";
import { publicPath } from "../../lib/public-path";
import {
  IconApps, IconBolt, IconBookmark, IconChart, IconDoc, IconFlame, IconGrid, IconHeart, IconHistory, IconList, IconMessage, IconPlug,
} from "../icons";

export interface NavItem {
  to: string;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  /** Match the path exactly (the home page). */
  end?: boolean;
  /** Shows the unread dot while the changelog has news. */
  changelog?: boolean;
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
  ...(FEATURES.leaderboard ? [{ to: "/leaderboard", label: "模型榜", icon: IconChart }] : []),
  ...(FEATURES.codexResetMonitor ? [{ to: "/codex-reset", label: "Tibo重置监控", icon: IconHistory }] : []),
];

const OPTIONAL_PATHS = OPTIONAL_ITEMS.map((item) => item.to);

export const SIDEBAR: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "内容",
    items: [
      { to: "/", label: "精选", icon: IconBolt, end: true },
      { to: "/all", label: `全部${withSubject("动态")}`, icon: IconList },
      { to: "/hot", label: "热点榜", icon: IconFlame },
      { to: "/daily", label: withSubject("日报"), icon: IconDoc },
      { to: "/topics", label: "主题", icon: IconGrid },
      { to: "/boards", label: "板块", icon: IconApps },
      { to: "/starred", label: "收藏", icon: IconBookmark },
    ],
  },
  // The optional AI-only modules (industry/features.ts), listed from the same flag test as MORE_PATHS.
  ...(OPTIONAL_ITEMS.length ? [{ title: "模型", items: OPTIONAL_ITEMS }] : []),
  {
    title: "更多",
    items: [
      { to: "/agent", label: "Agent 接入", icon: IconPlug },
      { to: "/about", label: "关于", icon: IconHeart },
      { to: "/changelog", label: "更新日志", icon: IconHistory, changelog: true },
      { to: "/feedback", label: "反馈", icon: IconMessage },
    ],
  },
];

export const TABBAR: NavItem[] = [
  { to: "/", label: "精选", icon: IconBolt, end: true },
  { to: "/all", label: "全部", icon: IconList },
  { to: "/daily", label: "日报", icon: IconDoc },
  { to: "/more", label: "更多", icon: IconApps, changelog: true },
];

/** Pages reached from the mobile "更多" tab keep that tab highlighted. Closed modules are absent. */
export const MORE_PATHS = ["/more", "/hot", "/topics", "/boards", "/starred", ...OPTIONAL_PATHS, "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy"];

export function tabIsActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  if (item.to === "/more") return MORE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (item.to === "/daily") return /^\/(daily|weekly|monthly)(\/|$)/.test(pathname);
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
