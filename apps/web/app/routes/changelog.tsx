import { SITE } from "@aihot/industry/site";
import { useEffect } from "react";
import { Link, useLoaderData } from "react-router";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { setChangelogSeen } from "../lib/local-state";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconChevronRight } from "../components/icons";
import { Inline, dateHeading } from "../features/changelog/text";
import { MajorRelease } from "../features/changelog/MajorRelease";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

interface Release {
  date: string;
  time: string;
  /**
   * Written by whoever adds the entry (`industry/changelog.json`), so it is not a closed set: a fixed
   * union rotted the moment 修复/扩充/精简 appeared — those dots rendered `class="… undefined"` (no colour)
   * and the sidebar could not filter them at all (measured 2026-10-05).
   */
  kind: string;
  title: string;
  body: string[];
  major?: boolean;
  /** 按发布顺序编号的站点版本（2.0.0 = 2026-10-24 重大更新），API 层注入。 */
  version?: string;
}

export async function loader({ request }: { request: Request }) {
  // 5xx 按约定报 503（并且不会被缓存成一个假的"没有更新"），而不是把加载器的异常抛成 500。
  const data = await loadOr404<{ latestVersion: string; releases: Release[] }>("/api/site/changelog", { signal: request.signal });
  // 类型筛选走查询参数而不是组件里的 state：这一页是读者会收藏、会互相转发的地址，
  // 「只看修复」必须在他把链接发出去之后仍然有效，也必须在不执行脚本的阅读器上可用。
  return { ...data, kind: new URL(request.url).searchParams.get("kind") };
}

export function meta() {
  return pageMeta({ title: "更新日志", description: `${SITE.name} 的功能更新、优化、公告与下线记录。`, path: "/changelog", image: "/og/pages/changelog.png" });
}

/**
 * 本站的更新只有这五种类型（2026-10-13 把原先 11 种并到这里：扩充/新增→新增、变更/下线/精简/数据/体验→更新或优化）。
 * 认不出的类型仍然给一颗点，只是灰色——侧栏与正文的颜色不能依赖这张表是否齐全（`kind: string` 的注释记着那次事故）。
 */
const KIND_DOT: Record<string, string> = {
  更新: "bg-accent",
  新增: "bg-hot",
  优化: "bg-ok",
  公告: "bg-amber",
  修复: "bg-ink-2",
};
const kindDot = (kind: string) => KIND_DOT[kind] ?? "bg-ink-2";

function ReleaseBody({ lines }: { lines: string[] }) {
  const blocks: Array<string | string[]> = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (!line.startsWith("- ")) blocks.push(line);
    else if (Array.isArray(last)) last.push(line.slice(2));
    else blocks.push([line.slice(2)]);
  }
  // `wrap-anywhere` is load-bearing, not decoration: a release note quotes real paths
  // (`packages/backend/src/reports/compose.ts:135`), which is one unbreakable Latin run. The bullet is a
  // flex child, so its `min-width: auto` was min-content — 364px on a 390px screen — and /changelog
  // scrolled sideways at 390px (scrollWidth 400 vs clientWidth 390). `overflow-wrap: anywhere` is the one
  // value that also shrinks min-content; `break-word` does not. Verified in the real browser at 390px.
  // The measure is the site's own token rather than 52em: at this 13.5px the old cap measured 47 Han
  // characters to a line, over the 42 the rest of the site's prose holds.
  const text = "measure mt-3 text-[14px] leading-[1.9] text-ink-3 wrap-anywhere sm:text-[15px]";
  return blocks.map((b, i) =>
    Array.isArray(b) ? (
      <ul key={i} className={`${text} space-y-1`}>
        {b.map((li, j) => (
          <li key={j} className="flex gap-2">
            <span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
            <span>
              <Inline text={li} />
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <p key={i} className={text}>
        <Inline text={b} />
      </p>
    ),
  );
}

export default function ChangelogPage() {
  const data = useLoaderData<typeof loader>();
  useEffect(() => setChangelogSeen(data.latestVersion), [data.latestVersion]);
  // The filter offers the kinds the file actually contains, newest first: adding a new kind to
  // `industry/changelog.json` then needs no code change to be colour-marked and filterable.
  const kinds = [...new Set(data.releases.map((r) => r.kind))];
  const kind = data.kind && kinds.includes(data.kind) ? data.kind : null;
  // 一个已经不存在的类型（旧书签、别人转过来的老链接）不静默退回"全部"：那一屏看起来像"这一类没有更新"，
  // 而真相是这一类被并掉了。说清楚，并给回全部的路。
  const retired = data.kind && !kind ? data.kind : null;
  const groups = new Map<string, Release[]>();
  for (const r of data.releases) if (!kind || r.kind === kind) groups.set(r.date, [...(groups.get(r.date) ?? []), r]);
  // Pin the newest matching major once. Keep groups intact for month counts and stable date links.
  const pinned = [...groups.values()].flat().find(release => release.major);
  // Month → the newest date shown in it (the jump target) and how many entries it holds.
  const months = new Map<string, { first: string; count: number }>();
  for (const [date, releases] of groups) {
    const month = months.get(date.slice(0, 7)) ?? { first: date, count: 0 };
    month.count += releases.length;
    months.set(date.slice(0, 7), month);
  }

  const aside = (
    <>
      <AsideCard title="按类型看" className="hidden lg:block">
        <nav aria-label="按类型看" className="-mx-2 -mb-1">
          {[null, ...kinds].map((k) => (
            <Link
              key={k ?? "all"}
              to={k ? { search: `?kind=${encodeURIComponent(k)}` } : { search: "" }}
              aria-current={kind === k ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-[13.5px] transition-colors ${kind === k ? "bg-bg-sunk font-medium text-ink dark:bg-bg-muted/60" : "text-ink-2 hover:bg-bg-sunk hover:text-ink"}`}
            >
              <span className={`size-1.5 rounded-full ${k ? kindDot(k) : "bg-ink-2"}`} aria-hidden="true" />
              <span className="flex-1">{k ?? "全部"}</span>
              <span className="num text-[12px] text-ink-4">{k ? data.releases.filter((r) => r.kind === k).length : data.releases.length}</span>
            </Link>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="按月份" className="hidden lg:block">
        <nav aria-label="按月份" className="-mx-2 -mb-1">
          {[...months.entries()].map(([month, m]) => {
            const [y, mo] = month.split("-").map(Number) as [number, number];
            return (
              <a key={month} href={`#d-${m.first}`} className="flex items-center justify-between rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
                {y} 年 {mo} 月<span className="num text-[12px] text-ink-4">{m.count} 条</span>
              </a>
            );
          })}
        </nav>
      </AsideCard>
      <AsideCard title="有想法或遇到问题">
        <p className="text-[13px] leading-[1.75] text-ink-3">想要的功能、用着不顺的地方，都可以在反馈页告诉我们。</p>
        <Link to="/feedback" prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          去反馈 <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );

  return (
    <ReadingLayout aside={aside}>
      <header className="pb-6">
        <h1 className="text-[26px] font-bold leading-[1.3] text-ink">更新日志</h1>
        <p className="mt-2 text-[14px] text-ink-3">新功能、调整与修复，都写在这里。</p>
      </header>
      {pinned && <div className="mb-6 scroll-mt-6" id={groups.get(pinned.date)?.length === 1 ? `d-${pinned.date}` : undefined}><MajorRelease date={pinned.date} time={pinned.time} /></div>}
      {retired && (
        <p className="mb-5 rounded-control bg-bg-sunk px-4 py-3 text-[13px] leading-[1.7] text-ink-2">
          「{retired}」这一类已经并到现在的五种类型里，所以下面按全部给你看。
        </p>
      )}
      <div className="space-y-4">
        {[...groups.entries()].map(([date, releases]) => {
          const remaining = releases.filter(release => release !== pinned);
          if (!remaining.length) return null;
          const h = dateHeading(date);
          return (
            <section key={date} id={`d-${date}`} className="scroll-mt-6 space-y-4">
              <div className="card px-5 sm:px-7">
              <h2 className="flex items-baseline gap-3 border-b border-line-soft py-5">
                <time dateTime={date} className="text-[20px] font-bold text-ink sm:text-[22px]">
                  {h.label}
                </time>
                <span className="text-[12px] text-ink-4">{h.weekday}</span>
              </h2>
              <ol>
                {remaining.map((r) => (
                  <li key={`${r.date}-${r.time}-${r.title}`} className="grid gap-x-8 gap-y-3 border-b border-line-soft py-6 last:border-b-0 sm:grid-cols-[88px_minmax(0,1fr)]">
                    <div className="flex items-center gap-3 sm:block">
                      <span className="mono block text-[12.5px] text-ink-3">{r.time}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-4 sm:mt-1.5">
                        <span className={`size-1.5 rounded-full ${kindDot(r.kind)}`} aria-hidden="true" />
                        {r.kind}
                      </span>
                    </div>
                    <article className="min-w-0 sm:border-l sm:border-line sm:pl-8">
                      <h3 className="text-[16px] font-bold leading-[1.5] text-ink sm:text-[17px]">
                        {r.title}
                        {r.version && <span className="mono ml-2 align-middle text-[12px] font-normal text-ink-4">v{r.version}</span>}
                      </h3>
                      <ReleaseBody lines={r.body} />
                    </article>
                  </li>
                ))}
              </ol>
              </div>
            </section>
          );
        })}
      </div>
    </ReadingLayout>
  );
}
