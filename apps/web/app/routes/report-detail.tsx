import { SITE, withSubject } from "@aihot/industry/site";
import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/report-detail";
import type { ReportDetail, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { apiGet, loadOr404 } from "../lib/api.server";
import { pageMeta, titled } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { KIND_LABEL, kindFromPath } from "../features/report/format";

const PATTERN: Record<ReportKind, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const key = params.key ?? "";
  if (!PATTERN[kind].test(key)) throw data({ message: "not_found" }, { status: 404 });
  const now = Date.now();
  const [report, { items: index }] = await Promise.all([
    loadOr404<ReportDetail>(`/api/site/reports/${kind}/${key}`, { signal: request.signal }),
    apiGet<{ items: ReportNavigationEntry[] }>(`/api/site/reports/${kind}/navigation/${key}`, { signal: request.signal }),
  ]);
  // 直接点开一份窗口还没合上的期是允许的，报头会写明它未出刊；`now` 由 loader 给出，服务端与客户端一致。
  return { report, index, today: beijingDate(now), now };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("报告不存在") }, { name: "robots", content: "noindex" }];
  const r = loaderData.report;
  return pageMeta({
    title: r.kind === "daily" ? `${withSubject("日报")} ${r.key}` : `${withSubject(KIND_LABEL[r.kind])} ${r.key}`,
    description: r.lead?.leadParagraph ?? r.overview?.slice(0, 150) ?? `${SITE.name} ${r.key} 的${withSubject(KIND_LABEL[r.kind])}。`,
    path: `/${r.kind}/${r.key}`,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    type: "article",
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=600" };
}

export default function ReportDetailPage() {
  const { report, index, today, now } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={report.kind} index={index} current={report.key} today={today} now={now}>
      <ReportPaper report={report} index={index} now={now} />
    </ReportLayout>
  );
}
