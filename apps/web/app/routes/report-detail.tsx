import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, useLoaderData } from "react-router";
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
  if (!PATTERN[kind].test(key)) throw withHeaders({ message: "not_found" }, { status: 404 });
  const now = Date.now();
  // 往期栏是装饰：它读不到不能带走这一期报纸。但它读不到时栏目是空的，空栏会被读成"没有往期"，
  // 所以把这件事记下来，由页面自己说一句实话，而不是沉默地留一个空栏。
  const [report, nav] = await Promise.all([
    loadOr404<ReportDetail>(`/api/site/reports/${kind}/${key}`, { signal: request.signal }),
    apiGet<{ items: ReportNavigationEntry[] }>(`/api/site/reports/${kind}/navigation/${key}`, { signal: request.signal }).catch((error: unknown) => {
      if (request.signal.aborted) throw error;
      return null;
    }),
  ]);
  const navFailed = nav === null;
  // 直接点开一份窗口还没合上的期是允许的，报头会写明它未出刊；`now` 由 loader 给出，服务端与客户端一致。
  return withHeaders(
    { report, index: nav?.items ?? [], navFailed, today: beijingDate(now), now },
    // 往期栏没读到时不能按 3600 秒缓存：那会把一个空栏播一个小时。这一期本身照旧可缓存。
    { headers: { "Cache-Control": navFailed ? "public, max-age=0, s-maxage=60" : "public, max-age=0, s-maxage=3600, stale-while-revalidate=600" } },
  );
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

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  // 缓存策略在 loader 里按 navFailed 定；错误响应到这里是空头，服务端会按状态码强制 no-store。
  return loaderHeaders;
}

export default function ReportDetailPage() {
  const { report, index, navFailed, today, now } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={report.kind} index={index} current={report.key} today={today} now={now}>
      {navFailed && (
        <p role="status" className="mb-3 rounded-control border border-line bg-raised px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">
          往期列表这一次没有读到，左栏因此是空的——这不代表没有往期，这一期报纸本身照常可读。
        </p>
      )}
      <ReportPaper report={report} index={index} now={now} />
    </ReportLayout>
  );
}
