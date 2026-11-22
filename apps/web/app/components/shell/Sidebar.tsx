import { SITE } from "@aihot/industry/site";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Wordmark } from "../Logo";
import { useChangelogSeen } from "../../lib/local-state";
import { localeAppPath, useLocale } from "../../lib/i18n";
import { copy as chrome } from "../../lib/i18n/shell";
import { SIDEBAR, navIsActive, navLabel, type NavItem } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";
import { LangSwitch } from "./LangSwitch";
import { IconGitHub } from "../icons";

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
  const locale = useLocale();
  const chromeC = chrome[locale];
  // Weekly and monthly reports belong to the daily report entry, as the phone tab bar has it.
  // 高亮与去处都按语言折算：/en 页的 pathname 是 /en/daily，词表里的 to 是裸路径——直接比永远失配，
  // 链接不带前缀则一点就落回中文页（2026-11-22 第 2 轮验收）。localeAppPath(pathname, "zh") 把 /en 剥回裸路径。
  const isActive = navIsActive(item, localeAppPath(pathname, "zh"));
  const Icon = item.icon;
  const className = `flex h-10 items-center gap-2.5 rounded-control px-2.5 text-[14px] transition-colors duration-150 ${
    isActive ? "bg-accent/10 font-semibold text-ink dark:bg-accent-soft" : "font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink"
  }`;
  const body = (
    <>
      <span className={`flex w-[22px] shrink-0 justify-center ${isActive ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{navLabel(item, locale)}</span>
      {/* The dot is decoration for the eye and text for a screen reader: colour alone must not carry "there is
          something new here" (WCAG 1.4.1), and an aria-label on a bare span is discarded. */}
      {dot && item.changelog && (
        <>
          <span className="ml-auto size-1.5 shrink-0 rounded-full bg-hot" aria-hidden="true" />
          <span className="sr-only">{chromeC.dotSuffix}</span>
        </>
      )}
    </>
  );
  return (
    <Link to={localeAppPath(item.to, locale)} prefetch="intent" aria-current={isActive ? "page" : undefined} className={className}>
      {body}
    </Link>
  );
}

export function Sidebar({ changelogVersion }: { changelogVersion: string | null }) {
  const dot = useChangelogDot(changelogVersion);
  const locale = useLocale();
  const chromeC = chrome[locale];
  return (
    <aside className="sticky top-0 hidden h-dvh w-[180px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-3.5 pt-6 lg:flex">
      <Link to={localeAppPath("/", locale)} prefetch="intent" className="mb-4 flex h-[50px] items-center px-1 text-ink" aria-label={chromeC.homeAria}>
        <Wordmark size={24} />
      </Link>
      <nav className="-mx-1 flex-1 overflow-y-auto px-1" aria-label={chromeC.mainNav}>
        {SIDEBAR.map((section, i) => {
          const headingId = `sidebar-group-${i}`;
          return (
            // The group names ("内容"、"更多") were invisible to a screen reader: a bare <div> labels
            // nothing, so navigating the nav announced a run of links with no structure. `role=group` +
            // aria-labelledby says what they are without adding headings to a page that already has its
            // own outline; the classes, and therefore the look, are unchanged.
            <div key={section.title} role="group" aria-labelledby={headingId}>
              <div id={headingId} className="px-2.5 pb-1 pt-3.5 text-[11px] text-ink-4">{locale === "en" ? section.titleEn : section.title}</div>
              <div className="flex flex-col gap-1">
                {section.items.map((item) => (
                  <SideLink key={item.to} item={item} dot={dot} />
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="mt-2 space-y-2.5 px-1 pt-1">
        {SITE.repoUrl && (
          <a
            href={SITE.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 items-center justify-center gap-1.5 rounded-control border border-line-soft text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink"
          >
            <IconGitHub size={14} />
            {chromeC.github}
          </a>
        )}
        <ThemeSwitch className="mx-1" />
        <LangSwitch className="mx-1" />
        {SITE.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="block px-2 text-[10px] text-ink-4 hover:text-ink-3">
            {SITE.icp}
          </a>
        )}
      </div>
    </aside>
  );
}
