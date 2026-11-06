import { Link, isRouteErrorResponse, useRouteError, useRevalidator } from "react-router";
import type { Route } from "./+types/topics";
import { SITE } from "@aihot/industry/site";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Card } from "../../features/admin/ui";
import { bj, num } from "../../features/admin/format";

/** 主题轮换看板。数据来自 `topicRotationBoard()`：近 N 天可读条目 + 休眠状态 + 候选热词。 */
interface Board {
  generatedAt: string;
  windowDays: number;
  dormant: number;
  topics: Array<{ slug: string; name: string; group: string; items30: number; lastItemAt: string | null; dormantAt: string | null; note: string | null }>;
  proposals: Array<{ tag: string; articles: number; firstSeen: string | null; lastSeen: string | null; seenAt: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "30";
  try {
    return await adminGet<Board>(request, `/api/admin/topics?days=${encodeURIComponent(days)}`, 10_000);
  } catch (error) {
    if (error instanceof Response || request.signal.aborted) throw error;
    return { generatedAt: new Date().toISOString(), windowDays: 30, dormant: 0, topics: [], proposals: [] } satisfies Board;
  }
}

export const meta: Route.MetaFunction = () => [{ title: `主题轮换 · ${SITE.name} 后台` }];

const group: Record<string, string> = { company: "机构", field: "领域", genre: "体裁" };

export function ErrorBoundary() {
  const error = useRouteError();
  const retry = useRevalidator();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <AdminPage title="主题轮换">
      <Card>
        <p role="alert" className="text-ink-3">{missing ? "这个看板还没有部署到这台机器上。" : "主题看板暂时无法加载；轮换任务本身不受影响。"}</p>
        <button className="mt-4 text-accent" onClick={() => retry.revalidate()}>重新加载</button>
      </Card>
    </AdminPage>
  );
}

export default function TopicRotationPage({ loaderData }: Route.ComponentProps) {
  const d = loaderData;
  const empty = d.topics.filter((t) => t.items30 === 0 && !t.dormantAt);
  const revived = d.topics.filter((t) => t.items30 >= 3 && t.dormantAt);
  const hottest = d.topics.slice(0, 12);
  return (
    <AdminPage title="主题轮换">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-[13px] text-ink-3">
            近 <span className="num text-ink">{d.windowDays}</span> 天的可读条目、休眠状态与候选热词。数据生成于 {bj(d.generatedAt)}
          </p>
          <div className="flex gap-3 text-[13px]">
            <Link className="text-accent" to="?days=7">7 天</Link>
            <Link className="text-accent" to="?days=30">30 天</Link>
            <Link className="text-accent" to="?days=90">90 天</Link>
          </div>
        </div>
        <ul className="mt-4 grid gap-2 text-[13px] text-ink-2 sm:grid-cols-3">
          <li>主题 <span className="num text-ink">{d.topics.length}</span> 个</li>
          <li>已归档 <span className="num text-ink">{d.dormant}</span> 个</li>
          <li>零条目未归档 <span className="num text-ink">{empty.length}</span> 个</li>
        </ul>
        {(empty.length > 0 || revived.length > 0) && (
          <div className="mt-4 space-y-1 text-[12.5px] text-ink-3">
            {empty.length > 0 && <p>下次换班会归档：{empty.map((t) => t.slug).join("、")}</p>}
            {revived.length > 0 && <p>又有新货、换班会复活：{revived.map((t) => t.slug).join("、")}</p>}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-[15px] text-ink">最活跃的 {hottest.length} 个主题</h2>
        <table className="w-full text-left text-[13px]">
          <thead className="text-ink-4">
            <tr>
              <th className="py-1.5">主题</th>
              <th className="py-1.5">组</th>
              <th className="py-1.5 text-right">条目</th>
              <th className="py-1.5">最后一条</th>
              <th className="py-1.5">状态</th>
            </tr>
          </thead>
          <tbody>
            {hottest.map((t) => (
              <tr key={t.slug} className="border-t border-line-soft">
                <td className="py-1.5"><Link className="text-accent" to={`/topics/${t.slug}`}>{t.name}</Link><span className="ml-2 text-ink-4">{t.slug}</span></td>
                <td className="py-1.5 text-ink-3">{group[t.group] ?? t.group}</td>
                <td className="num py-1.5 text-right">{num(t.items30)}</td>
                <td className="py-1.5 text-ink-3">{t.lastItemAt ? bj(t.lastItemAt) : "—"}</td>
                <td className="py-1.5">{t.dormantAt ? <span className="text-ink-4">已归档</span> : <span className="text-ink-2">在岗</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {hottest.length === 0 && <p className="py-8 text-center text-ink-3">还没有主题数据。</p>}
      </Card>

      <Card>
        <h2 className="mb-3 text-[15px] text-ink">候选热词（{d.proposals.length}）</h2>
        <p className="mb-3 text-[12.5px] text-ink-3">每天 04:30 从最近 30 天出现 ≥8 次的标签里挑，排除已认领与体裁标签。升成主题要人拍板，所以这里只排队。</p>
        <table className="w-full text-left text-[13px]">
          <thead className="text-ink-4">
            <tr>
              <th className="py-1.5">热词</th>
              <th className="py-1.5 text-right">条目</th>
              <th className="py-1.5">第一次</th>
              <th className="py-1.5">最后一次</th>
            </tr>
          </thead>
          <tbody>
            {d.proposals.map((p) => (
              <tr key={p.tag} className="border-t border-line-soft">
                <td className="py-1.5 text-ink">{p.tag}</td>
                <td className="num py-1.5 text-right">{num(p.articles)}</td>
                <td className="py-1.5 text-ink-3">{p.firstSeen ? bj(p.firstSeen) : "—"}</td>
                <td className="py-1.5 text-ink-3">{p.lastSeen ? bj(p.lastSeen) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.proposals.length === 0 && <p className="py-8 text-center text-ink-3">候选为空——现有主题已经覆盖了最近的热词。</p>}
      </Card>
    </AdminPage>
  );
}
