import { Link, useLocation } from "react-router";
import { TABBAR, tabIsActive } from "./nav";
import { useChangelogDot } from "./Sidebar";
import { publicPath } from "../../lib/public-path";

/** Bottom tab bar of the mobile shell (up to 960px), as on the original site. */
export function MobileTabBar({ changelogVersion }: { changelogVersion: string | null }) {
  const { pathname } = useLocation();
  const dot = useChangelogDot(changelogVersion);
  return (
    <nav aria-label="底部导航" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <div className="mx-auto grid h-[54px] max-w-[640px] grid-cols-4">
        {TABBAR.map((t) => {
          const active = tabIsActive(t, pathname);
          const Icon = t.icon;
          // Same reason as the sidebar: the client router cannot match the bare basename, so the home
          // tab points straight at `<base>/` with a real anchor instead of going through a router Link.
          const className = `relative flex flex-col items-center justify-center gap-[3px] text-[11px] transition-colors ${active ? "font-semibold text-accent" : "text-ink-3 active:text-ink"}`;
          const body = (
            <>
              <Icon size={21} />
              <span>{t.label}</span>
              {/* Same as the sidebar: the dot is decoration, the news is text (1.4.1 must not be colour-only). */}
              {dot && t.changelog && (
                <>
                  <span className="absolute right-[calc(50%-17px)] top-2 size-1.5 rounded-full bg-hot" aria-hidden="true" />
                  <span className="sr-only">，有新的更新</span>
                </>
              )}
            </>
          );
          return t.to === "/" ? (
            <a key={t.to} href={publicPath("/")} aria-current={active ? "page" : undefined} className={className}>
              {body}
            </a>
          ) : (
            <Link key={t.to} to={t.to} prefetch="intent" aria-current={active ? "page" : undefined} className={className}>
              {body}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
