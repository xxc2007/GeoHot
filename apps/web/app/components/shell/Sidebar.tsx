import { SITE } from "@aihot/industry/site";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Wordmark } from "../Logo";
import { useChangelogSeen } from "../../lib/local-state";
import { SIDEBAR, tabIsActive, type NavItem } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";
import { publicPath } from "../../lib/public-path";

/** True while the changelog has an entry newer than the one this reader last opened. */
export function useChangelogDot(latestVersion: string | null): boolean {
  const seen = useChangelogSeen();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !latestVersion) return false;
  return !seen || seen < latestVersion;
}

function SideLink({ item, dot }: { item: NavItem; dot: boolean }) {
  const { pathname } = useLocation();
  // Weekly and monthly reports belong to the daily report entry, as the phone tab bar has it.
  const isActive = tabIsActive(item, pathname);
  const Icon = item.icon;
  // React Router cannot match the bare base path: with basename `/geohot`, the client router resolves
  // `/geohot` to an empty path and falls through to the 404 route, so the home tab broke the moment a
  // reader navigated away and came back (the server was fine — SSR normalises the path). Its own
  // href is `/geohot` because `to="/"` + basename has no trailing slash. So the home entry gets a real
  // anchor onto `<base>/`, which is exactly the URL the router can match.
  const home = item.to === "/";
  const className = `flex h-10 items-center gap-2.5 rounded-control px-2.5 text-[14px] transition-colors duration-150 ${
    isActive ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
  }`;
  const body = (
    <>
      <span className={`flex w-[22px] shrink-0 justify-center ${isActive ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{item.label}</span>
      {/* The dot is decoration for the eye and text for a screen reader: colour alone must not carry "there is
          something new here" (WCAG 1.4.1), and an aria-label on a bare span is discarded. */}
      {dot && item.changelog && (
        <>
          <span className="ml-auto size-1.5 shrink-0 rounded-full bg-hot" aria-hidden="true" />
          <span className="sr-only">，有新的更新</span>
        </>
      )}
    </>
  );
  if (home) {
    return (
      <a href={publicPath("/")} aria-current={isActive ? "page" : undefined} className={className}>
        {body}
      </a>
    );
  }
  return (
    <Link to={item.to} prefetch="intent" aria-current={isActive ? "page" : undefined} className={className}>
      {body}
    </Link>
  );
}

export function Sidebar({ changelogVersion }: { changelogVersion: string | null }) {
  const dot = useChangelogDot(changelogVersion);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[180px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-3.5 pt-6 lg:flex">
      <a href={publicPath("/")} className="mb-4 flex h-[50px] items-center px-1 text-ink" aria-label={`${SITE.name} 首页`}>
        <Wordmark size={24} />
      </a>
      <nav className="-mx-1 flex-1 overflow-y-auto px-1" aria-label="主导航">
        {SIDEBAR.map((section) => (
          <div key={section.title}>
            <div className="px-2.5 pb-1 pt-3.5 text-[11px] text-ink-4">{section.title}</div>
            <div className="flex flex-col gap-1">
              {section.items.map((item) => (
                <SideLink key={item.to} item={item} dot={dot} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-2 space-y-2.5 px-1 pt-1">
        <ThemeSwitch className="mx-1" />
        {SITE.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="block px-2 text-[10px] text-ink-4 hover:text-ink-3">
            {SITE.icp}
          </a>
        )}
      </div>
    </aside>
  );
}
