import { SITE } from "@aihot/industry/site";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/daily-archive";
import type { ReportIndexEntry, ReportNavigationEntry } from "@aihot/contracts/site";
import { loadOr404, withLang } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/daily-archive";
import { MissingEnglishNotice } from "../components/ui/ChineseNotice";
import { beijingDate, beijingWeekday } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { archiveGroups, missingRuns, type MissingRun } from "../features/report/format";
import { Rows, SectionPage } from "../features/report/ReportPaper";
import { Nameplate } from "../features/report/Nameplate";

type Issue = ReportNavigationEntry & { short: string };
type ArchiveRow = { issue: Issue } | { gap: MissingRun };

const rowKey = (row: ArchiveRow) => ("issue" in row ? row.issue.key : row.gap.from);

export async function loader({ request }: { request: Request }) {
  const locale = localeFromPath(new URL(request.url).pathname);
  // loadOr404 而不是裸 apiGet：接口 5xx 要按约定的 503 说话，不是把加载器抛出一个未捕获异常变成 500。
  // /en 的归档也要英文期次标题（缺英文回退中文，页面标注）。
  const { items: index } = await loadOr404<{ items: ReportIndexEntry[] }>(withLang("/api/site/reports/daily", locale), { signal: request.signal });
  return { index, today: beijingDate(Date.now()) };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({ title: c.metaTitle, description: c.metaDescription, path: "/daily/archive", image: "/og/pages/daily.png", locale });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=300" };
}

export default function DailyArchive() {
  const { index, today } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const months = archiveGroups("daily", index, locale);
  const gaps = missingRuns(index);
  const byMonth = new Map<string, MissingRun[]>();
  for (const run of gaps) byMonth.set(run.month, [...(byMonth.get(run.month) ?? []), run]);
  const rowsFor = (month: string, entries: Issue[]): ArchiveRow[] =>
    [...entries.map((issue) => ({ issue })), ...(byMonth.get(month) ?? []).map((gap) => ({ gap }))].sort((a, b) => rowKey(b).localeCompare(rowKey(a)));
  // A month made only of空档 still gets its own section: printed issues on 28 September and 2 November
  // with nothing in between must not read as "the paper skipped October" — the archive would jump from
  // 九月 to 十一月 in silence, which is the very failure the 未出刊 row exists to remove.
  // 分组标题进字典：中文与 format.ts archiveGroups 给 daily 的 label 逐字相同（两处原本就是同一句
  // 「YYYY 年 N 月」），英文按月份键换成 "September 2025" 这类写法。
  const groups = [
    ...months.map((m) => ({ id: m.id, label: c.monthLabel(m.id), items: rowsFor(m.id, m.entries) })),
    ...[...byMonth.keys()].filter((id) => !months.some((m) => m.id === id)).map((id) => ({ id, label: c.monthLabel(id), items: rowsFor(id, []) })),
  ].sort((a, b) => b.id.localeCompare(a.id));
  return (
    <ReportLayout kind="daily" index={index} current={null} today={today}>
      <div className="@container">
        <header className="pt-5 lg:pt-0">
          <div className="flex items-center justify-between gap-4 text-[12px] text-ink-4">
            <span>{SITE.name} · {c.subject}</span>
            <span>
              {c.countPre}<span className="num">{index.length}</span>{c.countPost}
            </span>
          </div>
          <div className="py-6 @[880px]:py-8">
            <h1 id="report-start">
              <span className="sr-only">{c.boundTitle}</span>
              <Nameplate which="archive" className="block h-[50px] w-auto @[520px]:h-[70px] @[880px]:h-[98px]" />
            </h1>
          </div>
          <div aria-hidden="true" className="border-t border-line-strong" />
        </header>
        {/* 只有归档里真的还有中文期次标题时才标注。中文页永不渲染。 */}
        {index.some((e) => e.textLocale !== "en") && <MissingEnglishNotice className="mt-1" />}
        {/* 空档是这份报纸的事实，不是排版留白：读者两次把「归档跳过三天」读成同步坏了，所以这里自己说明。
            这一行不是链接——空刊照既有决定不进任何出口（`readableRows` 挡在索引层），按地址直达时才给
            200 的诚实空态。这里说的是"那天没出刊"这件事，不是"那天有一期你可以去翻"。 */}
        {gaps.length > 0 && (
          <p className="pt-4 text-[12px] leading-[1.75] text-ink-4">
            <span className="font-semibold text-ink-2">{c.notPublished}</span>{c.notPublishedBody}
          </p>
        )}
        {/* 一期都还没有时的样子：说没有，而不是留一张只有报头的白页。 */}
        {groups.length === 0 ? (
          <EmptyState as="h1" title={c.emptyTitle}>{c.emptyBody}</EmptyState>
        ) : null}
        {groups.map((g) => (
          <SectionPage key={g.id} id={`m-${g.id}`} label={g.label}>
            <Rows items={g.items}>
              {(row, cell) =>
                "gap" in row ? (
                  <div key={row.gap.from} className={`flex gap-4 py-4 ${cell}`}>
                    <span className="flex w-9 shrink-0 flex-col items-center">
                      <span className="num text-[24px] font-black leading-none tracking-[-0.03em] text-ink-4">{row.gap.from.slice(8, 10)}</span>
                      <span className="mt-1.5 text-[10.5px] leading-none text-ink-4">{c.weekday(beijingWeekday(row.gap.from))}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-bold leading-[1.55] text-ink-4">{c.notPublished}</span>
                      <span className="mt-1 block text-[12px] text-ink-4">{c.runLabel(row.gap)}</span>
                    </span>
                  </div>
                ) : (
                  <Link key={row.issue.key} to={localeAppPath(`/daily/${row.issue.key}`, locale)} prefetch="intent" className={`group flex gap-4 py-4 ${cell}`}>
                    <span className="flex w-9 shrink-0 flex-col items-center">
                      <span className="num text-[24px] font-black leading-none tracking-[-0.03em] text-ink transition-colors group-hover:text-accent">{row.issue.key.slice(8, 10)}</span>
                      <span className="mt-1.5 text-[10.5px] leading-none text-ink-4">{c.weekday(beijingWeekday(row.issue.key))}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-bold leading-[1.55] text-ink transition-colors group-hover:text-accent">{row.issue.title ?? c.issueFallback(row.issue.key)}</span>
                      <span className="mt-1 block text-[12px] text-ink-4">
                        <span className="num">{row.issue.count}</span>{c.countUnit}
                      </span>
                    </span>
                  </Link>
                )
              }
            </Rows>
          </SectionPage>
        ))}
      </div>
    </ReportLayout>
  );
}
