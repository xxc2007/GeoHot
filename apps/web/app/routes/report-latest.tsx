import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, useLoaderData, useLocation, useRevalidator } from "react-router";
import type { Route } from "./+types/report-latest";
import type { ReportDetail, ReportNavigationEntry } from "@aihot/contracts/site";
import { apiGet, ApiError, loadOr404 } from "../lib/api.server";
import { pageMeta, titled } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { KIND_LABEL, kindFromPath } from "../features/report/format";

export async function loader({ request }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const now = Date.now();
  const { index, report } = await loadOr404<{ index: ReportNavigationEntry[]; report: ReportDetail | null }>(`/api/site/reports/${kind}/latest-page`, { signal: request.signal });
  // 最新的一期未必是出刊的一期：窗口还没合上的那一期只是一份稿样，读者的这一版仍是最近一期收口的。
  // 它照常留在往期栏和自己的网址里，只是不当作今天出的报纸。
  let latest = report;
  if (latest && Date.parse(latest.windowEnd) > now) {
    const proof = latest.key;
    latest = null;
    // 往前的每一期都可能读不到。读不到 ≠ 没有出刊：5xx 与网络故障记下来，一期都没读成就是接口故障，
    // 不能把它写成「还没有发布」（那是只有 index 真的是空的才说得出口的话）。
    let unreadable = false;
    for (const e of index.filter((x) => x.key !== proof).slice(0, 4)) {
      try {
        const older = await apiGet<ReportDetail>(`/api/site/reports/${kind}/${e.key}`, { signal: request.signal });
        if (older && Date.parse(older.windowEnd) <= now) {
          latest = older;
          break;
        }
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (error instanceof ApiError && error.status >= 500) {
          unreadable = true;
          continue;
        }
      }
    }
    if (!latest && unreadable) throw withHeaders({ message: "report_unavailable" }, { status: 503 });
  }
  // 一份都还没出刊（index 真是空的）与读不到最近几期是两件事：后者在上面抛错，不进这一份缓存。
  return withHeaders({ kind, report: latest, index, today: beijingDate(now), now }, { headers: { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=300" } });
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled(withSubject("日报")) }, { name: "robots", content: "noindex" }];
  const kind = loaderData.kind;
  return pageMeta({
    title: withSubject(KIND_LABEL[kind]),
    description: kind === "daily" ? `${SITE.name} 每天 08:00（北京时间）发布的${withSubject("日报")}。` : kind === "weekly" ? "每周综合回顾。" : "每月盘点。",
    path: location.pathname,
    image: `/og/pages/${kind}.png`,
  });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  // 缓存在 loader 里随结果一起定：成功（含诚实的空状态）才带 s-maxage=600，抛出去的错误没有这一项，
  // web 服务对非 200 一律改写成 no-store——缓存住一个错误，等于把一次接口故障播成十分钟的「还没有发布」。
  return loaderHeaders;
}

export default function ReportLatestPage() {
  const { kind, report, index, today, now } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={kind} index={index} current={report?.key ?? null} today={today} now={now}>
      {/* 「还没有发布」只说没有出刊的那件事：一条报纸都没读过到，走下面的 ErrorBoundary，不说这句话。 */}
      {report ? <ReportPaper report={report} index={index} now={now} /> : <EmptyState as="h1" title={`还没有发布${withSubject(KIND_LABEL[kind])}`}>第一期发布后会出现在这里。</EmptyState>}
    </ReportLayout>
  );
}

/**
 * 读不到最近一期（接口 5xx、超时）时的样子：一句实话 + 一次重试。
 * 这一页和「还没有出刊」的区别是这里的数据不支持任何结论，所以既不编一期报纸，也不说没有。
 */
export function ErrorBoundary() {
  const kind = kindFromPath(useLocation().pathname);
  const { revalidate, state } = useRevalidator();
  return (
    <ReportLayout kind={kind} index={[]} current={null} today={beijingDate(Date.now())}>
      <EmptyState
        as="h1"
        title={`暂时读不到${withSubject(KIND_LABEL[kind])}`}
        action={
          <button type="button" onClick={() => revalidate()} disabled={state === "loading"} className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-contrast hover:bg-accent-ink disabled:opacity-60">
            {state === "loading" ? "正在重试…" : "重试"}
          </button>
        }
      >
        服务没有给出这一页要用的数据，所以现在还不能说今天这一期出刊了没有。稍等几秒再试一次。
      </EmptyState>
    </ReportLayout>
  );
}
