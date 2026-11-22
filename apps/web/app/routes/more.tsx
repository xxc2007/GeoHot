import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import type { ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/more";
import type { loader as rootLoader } from "../root";
import { useChangelogDot } from "../components/shell/Sidebar";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/more";
import { ThemeSwitch } from "../components/shell/ThemeSwitch";
import { LangSwitch } from "../components/shell/LangSwitch";
import { IconBookmark, IconChart, IconChevronRight, IconGitHub, IconGlobe, IconGrid, IconHeart, IconHistory, IconMessage, IconMoon, IconPlug } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  return pageMeta({ title: copy[locale].title, path: "/more", noindex: true, locale });
}

/** 行的标签在字典里（copy.rows），GROUPS 只记录指向哪个键——两个语言共用同一张表。 */
type RowKey = keyof (typeof copy)["zh"]["rows"];

type Row = { to: string; label: RowKey; icon: ReactNode; external?: boolean };

const GROUPS: Array<{ key: keyof (typeof copy)["zh"]["groups"]; rows: Row[] }> = [
  {
    key: "content",
    rows: [
      { to: "/topics", label: "topics", icon: <IconGrid size={18} /> },
      ...(FEATURES.leaderboard ? ([{ to: "/leaderboard", label: "leaderboard", icon: <IconChart size={18} /> }] as Row[]) : []),
      ...(FEATURES.codexResetMonitor ? ([{ to: "/codex-reset", label: "codexReset", icon: <IconHistory size={18} /> }] as Row[]) : []),
      { to: "/agent", label: "agent", icon: <IconPlug size={18} /> },
    ],
  },
  {
    key: "prefs",
    rows: [
      { to: "/starred", label: "starred", icon: <IconBookmark size={18} /> },
    ],
  },
  {
    key: "about",
    rows: [
      { to: "/about", label: "aboutSite", icon: <IconHeart size={18} /> },
      { to: "/changelog", label: "changelog", icon: <IconHistory size={18} /> },
      { to: "/feedback", label: "feedback", icon: <IconMessage size={18} /> },
      // The sidebar carries this on desktop; on phones the sidebar is hidden, so the list carries it.
      ...(SITE.repoUrl ? ([{ to: SITE.repoUrl, label: "github", icon: <IconGitHub size={18} />, external: true }] as Row[]) : []),
    ],
  },
];

function Group({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    // Each card on this page is a section of the site, so the eyebrow is its heading: a bare <div> left
    // the <section> unnamed (no region in the landmark list) and gave keyboard/heading users nothing to
    // navigate by. Same classes, so the same look; the id is what carries it to the assistive tech.
    <section className="card overflow-hidden" aria-labelledby={id}>
      <h2 id={id} className="px-4 pb-1 pt-3 text-[11.5px] text-ink-4">{title}</h2>
      <ul className="divide-y divide-line-soft">{children}</ul>
    </section>
  );
}

export default function MorePage() {
  const locale = useLocale();
  const c = copy[locale];
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const changelogDot = useChangelogDot(root?.changelogVersion ?? null);
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      <h1 className="pb-4 pt-5 text-[22px] font-bold text-ink lg:pt-1">{c.title}</h1>
      <div className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0 2xl:grid-cols-3">
        {GROUPS.map((g, i) => (
          <Group key={g.key} id={`more-group-${i}`} title={c.groups[g.key]}>
            {g.rows.map((r) => {
              const inner = (
                <>
                  <span className="text-ink-3">{r.icon}</span>
                  <span className="flex flex-1 items-center gap-2">{c.rows[r.label]}{r.to === "/changelog" && changelogDot && <><span aria-hidden className="size-1.5 rounded-full bg-hot" /><span className="sr-only">{c.dotSuffix}</span></>}</span>
                  <IconChevronRight size={16} className="text-ink-4" />
                </>
              );
              const cls = "flex h-[50px] items-center gap-3 px-4 text-[15px] font-medium text-ink transition-colors active:bg-bg-sunk lg:hover:bg-bg-sunk";
              return (
                <li key={r.to}>
                  {r.external ? (
                    <a href={r.to} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>
                  ) : (
                    <Link to={localeAppPath(r.to, locale)} className={cls}>{inner}</Link>
                  )}
                </li>
              );
            })}
            {g.key === "prefs" && (
              <>
                <li className="flex h-[58px] items-center gap-3 px-4 text-[15px] font-medium text-ink">
                  <span className="text-ink-3">
                    <IconMoon size={18} />
                  </span>
                  <span className="flex-1">{c.appearance}</span>
                  {/* w-138：三段各 44px 宽——124px 时每段只有 39px，是 mobile-audit 在 390px 上量出的
                      最后一批不足 40px 的触控目标之一。 */}
                  <ThemeSwitch className="w-[138px]" />
                </li>
                <li className="flex h-[58px] items-center gap-3 px-4 text-[15px] font-medium text-ink">
                  <span className="text-ink-3">
                    <IconGlobe size={18} />
                  </span>
                  <span className="flex-1">{c.language}</span>
                  {/* 与上面那格外观开关同宽同高：同一行风格，语言切换胶囊 h-[34px]。 */}
                  <LangSwitch className="w-[138px]" />
                </li>
              </>
            )}
          </Group>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-ink-4">
        <Link to={localeAppPath("/terms", locale)} className="tap-hit inline-flex min-h-6 items-center px-1.5 hover:text-ink-2">{c.footerTerms}</Link>
        <Link to={localeAppPath("/privacy", locale)} className="tap-hit inline-flex min-h-6 items-center px-1.5 hover:text-ink-2">{c.footerPrivacy}</Link>
        {/* RSS 去Agent接入页而不是直接给/feed.xml：手机浏览器打开裸XML只会看到一屏源码，订阅地址在Agent页有说明和复制按钮。 */}
        <Link to={localeAppPath("/agent", locale)} className="tap-hit inline-flex min-h-6 items-center px-1.5 hover:text-ink-2">RSS</Link>
        {SITE.icp && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="tap-hit inline-flex min-h-6 items-center px-1.5 hover:text-ink-2">{SITE.icp}</a>}
      </div>
    </div>
  );
}
