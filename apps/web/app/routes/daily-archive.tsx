import { SITE, withSubject } from "@aihot/industry/site";
import { Link, useLoaderData } from "react-router";
import type { ReportIndexEntry, ReportNavigationEntry } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { beijingDate, beijingWeekday } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { archiveGroups, dayLabel, missingRuns, type MissingRun } from "../features/report/format";
import { Rows, SectionPage } from "../features/report/ReportPaper";
import { Nameplate } from "../features/report/Nameplate";

type Issue = ReportNavigationEntry & { short: string };
type ArchiveRow = { issue: Issue } | { gap: MissingRun };

const rowKey = (row: ArchiveRow) => ("issue" in row ? row.issue.key : row.gap.from);
/** "10月4日—6日 · 共 3 天"; a single missing day reads "10月5日 · 共 1 天". */
const runLabel = (run: MissingRun) =>
  `${dayLabel(run.from)}${run.days > 1 ? `—${Number(run.to.slice(8, 10))}日` : ""} · 共 ${run.days} 天`;

export async function loader({ request }: { request: Request }) {
  // loadOr404 而不是裸 apiGet：接口 5xx 要按约定的 503 说话，不是把加载器抛出一个未捕获异常变成 500。
  const { items: index } = await loadOr404<{ items: ReportIndexEntry[] }>("/api/site/reports/daily", { signal: request.signal });
  return { index, today: beijingDate(Date.now()) };
}

export function meta() {
  return pageMeta({ title: `${withSubject("日报")} · 历史存档`, description: `${SITE.name} 历史日报，按日期归档。`, path: "/daily/archive", image: "/og/pages/daily.png" });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=300" };
}

export default function DailyArchive() {
  const { index, today } = useLoaderData<typeof loader>();
  const months = archiveGroups("daily", index);
  const gaps = missingRuns(index);
  const byMonth = new Map<string, MissingRun[]>();
  for (const run of gaps) byMonth.set(run.month, [...(byMonth.get(run.month) ?? []), run]);
  const rowsFor = (month: string, entries: Issue[]): ArchiveRow[] =>
    [...entries.map((issue) => ({ issue })), ...(byMonth.get(month) ?? []).map((gap) => ({ gap }))].sort((a, b) => rowKey(b).localeCompare(rowKey(a)));
  // A month made only of空档 still gets its own section: printed issues on 28 September and 2 November
  // with nothing in between must not read as "the paper skipped October" — the archive would jump from
  // 九月 to 十一月 in silence, which is the very failure the 未出刊 row exists to remove.
  const groups = [
    ...months.map((m) => ({ id: m.id, label: m.label, items: rowsFor(m.id, m.entries) })),
    ...[...byMonth.keys()].filter((id) => !months.some((m) => m.id === id)).map((id) => ({ id, label: `${id.slice(0, 4)} 年 ${Number(id.slice(5, 7))} 月`, items: rowsFor(id, []) })),
  ].sort((a, b) => b.id.localeCompare(a.id));
  return (
    <ReportLayout kind="daily" index={index} current={null} today={today}>
      <div className="@container">
        <header className="pt-5 lg:pt-0">
          <div className="flex items-center justify-between gap-4 text-[12px] text-ink-4">
            <span>{SITE.name} · {withSubject("日报")}</span>
            <span>
              共 <span className="num">{index.length}</span> 期
            </span>
          </div>
          <div className="py-6 @[880px]:py-8">
            <h1 id="report-start">
              <span className="sr-only">日报合订本</span>
              <Nameplate which="archive" className="block h-[50px] w-auto @[520px]:h-[70px] @[880px]:h-[98px]" />
            </h1>
          </div>
          <div aria-hidden="true" className="border-t border-line-strong" />
        </header>
        {/* 空档是这份报纸的事实，不是排版留白：读者两次把「归档跳过三天」读成同步坏了，所以这里自己说明。
            这一行不是链接——空刊照既有决定不进任何出口（`readableRows` 挡在索引层），按地址直达时才给
            200 的诚实空态。这里说的是"那天没出刊"这件事，不是"那天有一期你可以去翻"。 */}
        {gaps.length > 0 && (
          <p className="pt-4 text-[12px] leading-[1.75] text-ink-4">
            <span className="font-semibold text-ink-2">未出刊</span>：那一天没有可读的一期——窗口内没有条目达到入选标准，或那一期引用的条目已全部下架。空刊不占期号，所以「第几期」会跳过它。
          </p>
        )}
        {/* 一期都还没有时的样子：说没有，而不是留一张只有报头的白页。 */}
        {groups.length === 0 ? (
          <EmptyState as="h1" title={`还没有${withSubject("日报")}存档`}>出刊之后，每一天的一期会按月份归到这里。</EmptyState>
        ) : null}
        {groups.map((g) => (
          <SectionPage key={g.id} id={`m-${g.id}`} label={g.label}>
            <Rows items={g.items}>
              {(row, cell) =>
                "gap" in row ? (
                  <div key={row.gap.from} className={`flex gap-4 py-4 ${cell}`}>
                    <span className="flex w-9 shrink-0 flex-col items-center">
                      <span className="num text-[24px] font-black leading-none tracking-[-0.03em] text-ink-4">{row.gap.from.slice(8, 10)}</span>
                      <span className="mt-1.5 text-[10.5px] leading-none text-ink-4">{beijingWeekday(row.gap.from).replace("星期", "周")}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-bold leading-[1.55] text-ink-4">未出刊</span>
                      <span className="mt-1 block text-[12px] text-ink-4">{runLabel(row.gap)}</span>
                    </span>
                  </div>
                ) : (
                  <Link key={row.issue.key} to={`/daily/${row.issue.key}`} prefetch="intent" className={`group flex gap-4 py-4 ${cell}`}>
                    <span className="flex w-9 shrink-0 flex-col items-center">
                      <span className="num text-[24px] font-black leading-none tracking-[-0.03em] text-ink transition-colors group-hover:text-accent">{row.issue.key.slice(8, 10)}</span>
                      <span className="mt-1.5 text-[10.5px] leading-none text-ink-4">{beijingWeekday(row.issue.key).replace("星期", "周")}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-bold leading-[1.55] text-ink transition-colors group-hover:text-accent">{row.issue.title ?? `${withSubject("日报")} ${row.issue.key}`}</span>
                      <span className="mt-1 block text-[12px] text-ink-4">
                        <span className="num">{row.issue.count}</span> 件大事
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
