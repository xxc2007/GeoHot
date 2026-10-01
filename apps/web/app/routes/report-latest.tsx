import { SITE, withSubject } from "@aihot/industry/site";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import type { ReportDetail, ReportNavigationEntry } from "@aihot/contracts/site";
import { apiGet, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
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
    for (const e of index.filter((x) => x.key !== proof).slice(0, 4)) {
      const older = await apiGet<ReportDetail>(`/api/site/reports/${kind}/${e.key}`, { signal: request.signal }).catch(() => null);
      if (older && Date.parse(older.windowEnd) <= now) {
        latest = older;
        break;
      }
    }
  }
  return { kind, report: latest, index, today: beijingDate(now), now };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const kind = loaderData?.kind ?? "daily";
  return pageMeta({
    title: withSubject(KIND_LABEL[kind]),
    description: kind === "daily" ? `${SITE.name} 每天 08:00（北京时间）发布的${withSubject("日报")}。` : kind === "weekly" ? "每周综合回顾。" : "每月盘点。",
    path: location.pathname,
    image: `/og/pages/${kind}.png`,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=300" };
}

export default function ReportLatestPage() {
  const { kind, report, index, today, now } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={kind} index={index} current={report?.key ?? null} today={today} now={now}>
      {report ? <ReportPaper report={report} index={index} now={now} /> : <EmptyState title={`还没有发布${withSubject(KIND_LABEL[kind])}`}>第一期发布后会出现在这里。</EmptyState>}
    </ReportLayout>
  );
}
