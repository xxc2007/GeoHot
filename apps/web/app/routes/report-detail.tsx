import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, isRouteErrorResponse, Link, useLoaderData, useLocation, useRouteError } from "react-router";
import type { Route } from "./+types/report-detail";
import type { ReportDetail, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { apiGet, ApiError, ApiRedirect } from "../lib/api.server";
import { pageMeta, titled } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { KIND_LABEL, KIND_PATH, absentCopy, kindFromPath, reportAbsentReason, type AbsentReason } from "../features/report/format";

/** The payload an absent edition throws, so the page can say which of its four kinds this is. */
interface ReportAbsent {
  message: "report_absent";
  reason: AbsentReason;
  kind: ReportKind;
  key: string;
}

const reportAbsent = (reason: AbsentReason, kind: ReportKind, key: string) => withHeaders<ReportAbsent>({ message: "report_absent", reason, kind, key }, { status: 404 });

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const key = params.key ?? "";
  const now = Date.now();
  const absentReason = reportAbsentReason(kind, key, now);
  if (absentReason === "bad_key") throw reportAbsent("bad_key", kind, key);
  // 写法没问题、库里却没有行时，还分得出「没出过」与「还没到」——这两种读者的下一步不一样，而 loadOr404
  // 把任何 404 都压成一条通用 not_found（它抛的是 data() 那个对象，不是 Response，`.status` 在 catch 里读不到）。
  // 所以这一条自己抓 apiGet：404 按 absentReason 分诊，400 与其余故障照 loadOr404 的原样给状态码。
  const fetchReport = async (): Promise<ReportDetail> => {
    try {
      return await apiGet<ReportDetail>(`/api/site/reports/${kind}/${key}`, { signal: request.signal });
    } catch (error) {
      if (request.signal.aborted || error instanceof ApiRedirect) throw error;
      if (error instanceof ApiError && error.status === 404) throw reportAbsent(absentReason, kind, key);
      if (error instanceof ApiError && error.status === 400) throw withHeaders({ message: "bad_request" }, { status: 400 });
      if (error instanceof ApiError) throw withHeaders({ message: "unavailable" }, { status: 503 });
      throw error;
    }
  };
  // 往期栏是装饰：它读不到不能带走这一期报纸。但它读不到时栏目是空的，空栏会被读成"没有往期"，
  // 所以把这件事记下来，由页面自己说一句实话，而不是沉默地留一个空栏。
  const [report, nav] = await Promise.all([
    fetchReport(),
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
  const meta = pageMeta({
    title: r.kind === "daily" ? `${withSubject("日报")} ${r.key}` : `${withSubject(KIND_LABEL[r.kind])} ${r.key}`,
    description: r.lead?.leadParagraph ?? r.overview?.slice(0, 150) ?? `${SITE.name} ${r.key} 的${withSubject(KIND_LABEL[r.kind])}。`,
    path: `/${r.kind}/${r.key}`,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    type: "article",
  });
  // 一页翻不开的报纸不该被搜索引擎当成一条内容收走：归档与报眼都管它叫「未出刊」，站外也不该有它的一格。
  return r.readable ? meta : [...meta, { name: "robots", content: "noindex" }];
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

/**
 * 这一期的网址没有报纸可显示时的样子。四种情形说四句话（`absentCopy`），因为共用的那句
 * 「内容已不再公开」暗示本站发过又撤了，而那对「没出过刊」「还没到出刊时间」「期号写错了」三种
 * 都是假话——第三种尤其重要：补刊会把 1 月到 9 月一段一段填起来，读者挑中一个还没有的日期时，
 * 不该读到一份报纸被撤回的口吻。
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const kind = kindFromPath(useLocation().pathname);
  const absent = isRouteErrorResponse(error) && error.status === 404 ? (error.data as Partial<ReportAbsent> | undefined) : undefined;
  const copy = absentCopy(absent?.kind ?? kind, absent?.key ?? "", absent?.reason ?? "unreadable");
  return (
    // index 是空栏、today 谁也读不到，所以照「最近一期」那页的写法给空串而不是挂钟：服务端与注水各算
    // 一次时间，等于给这一页埋一个文本不一致。
    <ReportLayout kind={kind} index={[]} current={null} today="">
      <EmptyState
        as="h1"
        title={copy.title}
        action={
          <Link to={KIND_PATH[kind]} className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-contrast hover:bg-accent-ink">
            看最近一期{KIND_LABEL[kind]}
          </Link>
        }
      >
        {copy.body}
      </EmptyState>
    </ReportLayout>
  );
}
