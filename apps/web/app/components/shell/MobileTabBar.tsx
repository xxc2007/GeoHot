import { Link, useLocation } from "react-router";
import { TABBAR, navLabel, tabIsActive } from "./nav";
import { useChangelogDot } from "./Sidebar";
import { LangSwitch } from "./LangSwitch";
import { localeAppPath, useLocale } from "../../lib/i18n";
import { copy as chrome } from "../../lib/i18n/shell";

/** Bottom tab bar of the mobile shell (up to 960px), as on the original site. 去处与高亮随页面语言折算。 */
export function MobileTabBar({ changelogVersion }: { changelogVersion: string | null }) {
  const { pathname } = useLocation();
  const locale = useLocale();
  const chromeC = chrome[locale];
  const dot = useChangelogDot(changelogVersion);
  const cells = (items: typeof TABBAR) =>
    items.map((t) => {
      // /en 页的 pathname 带 /en 前缀而词表里的 to 是裸路径：剥回裸路径再比，链接则按 locale 加前缀。
      const active = tabIsActive(t, localeAppPath(pathname, "zh"));
      const Icon = t.icon;
      const className = `relative flex flex-col items-center justify-center gap-[3px] text-[11px] transition-colors ${active ? "font-semibold text-accent" : "text-ink-3 active:text-ink"}`;
      const body = (
        <>
          <Icon size={21} />
          <span>{navLabel(t, locale)}</span>
          {/* Same as the sidebar: the dot is decoration, the news is text (1.4.1 must not be colour-only). */}
          {dot && t.changelog && (
            <>
              <span className="absolute right-[calc(50%-17px)] top-2 size-1.5 rounded-full bg-hot" aria-hidden="true" />
              <span className="sr-only">{chromeC.dotSuffix}</span>
            </>
          )}
        </>
      );
      return (
        <Link key={t.to} to={localeAppPath(t.to, locale)} prefetch="intent" aria-current={active ? "page" : undefined} className={className}>
          {body}
        </Link>
      );
    });
  return (
    <nav aria-label={chromeC.bottomNav} className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {/* 语言切换器在手机上必须每页都在：侧栏（LangSwitch 的桌面家）在 ≤960px 整块隐藏，
          此前只有 /more 正文里那一枚可见（2026-11-23 验收：390/320 下其余页面的切换器是 0×0）。
          做成第 6 格，尺寸与相邻五个链接同档；完整胶囊仍在 /more。 */}
      <div className="mx-auto grid h-[54px] max-w-[640px] grid-cols-6">
        {cells(TABBAR.slice(0, 4))}
        <LangSwitch compact className="h-full" />
        {cells(TABBAR.slice(4))}
      </div>
    </nav>
  );
}
