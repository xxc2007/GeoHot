import { SITE } from "@aihot/industry/site";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/content";
import { adminGet } from "../../lib/admin.server";
import { VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Input, Time } from "../../features/admin/ui";

interface Row {
  id: string;
  title: string;
  url: string;
  source: string;
  discovered_at: string;
  processing_state: string;
  visibility: string | null;
  selected: boolean | null;
  score: number | null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  // 最近入库要能一直往下拉：limit 由页面按需加 60，接口与 SQL 都认这个数（上限 600）。
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 60) || 60, 60), 600);
  // 空查询也要取数：页面一进来输入框是空的，这里若直接返回 []，整页就是空白（2026-11-07 实测 h=844）。
  // 接口侧对空查询给出最近 50 条，列与排序和带词查询一致，所以这里不需要第二套渲染。
  const { rows, hasMore } = await adminGet<{ rows: Row[]; hasMore: boolean }>(request, `/api/admin/content?q=${encodeURIComponent(q)}&limit=${limit}`);
  return { q, rows, limit, hasMore };
}

export const meta: Route.MetaFunction = () => [{ title: `内容诊断 · ${SITE.name} 后台` }];

export default function Content({ loaderData }: Route.ComponentProps) {
  const { q, rows, limit, hasMore } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  // 到底了就是「这次没拿满一页」；没到底时哨兵进入视口就把页大小加 60（replace 掉当前历史项，不打断回退）。
  const atEnd = !hasMore;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (atEnd || limit >= 600) return;
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      const next = Math.min(limit + 60, 600);
      const params = new URLSearchParams(q ? { q, limit: String(next) } : { limit: String(next) });
      navigate("?" + params.toString(), { replace: true, preventScrollReset: true });
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [atEnd, limit, q, navigate]);
  return (
    <AdminPage wide title="内容诊断" subtitle="按 ID、原文链接或标题找到任何一条内容，看它从信源到公开出口的完整链路；下架、仅摘要、人工修正和重处理都在详情页。">
      <Form method="get" className="mb-5 flex max-w-2xl gap-2">
        <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="内容 ID、URL 或标题关键词" aria-label="搜索内容" autoFocus />
        <Button type="submit" tone="primary">查找</Button>
      </Form>
      {(q || rows.length > 0) && (
        <Card pad={false} title={q ? `“${q}” 的结果` : "最近入库"} right={<span>{atEnd ? `${rows.length} 条` : `${rows.length} 条 · 继续下拉加载`}</span>}>
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/admin/content/${r.id}`)}
            empty="没有找到。URL 会先规范化再比对；标题支持中英文片段。"
            columns={[
              {
                key: "t",
                label: "标题",
                render: (r) => (
                  <div className="min-w-[320px]">
                    <Link to={`/admin/content/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                    <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  </div>
                ),
              },
              { key: "src", label: "信源", render: (r) => <span className="whitespace-nowrap">{r.source}</span> },
              {
                key: "st",
                label: "状态",
                render: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {r.selected && <Badge tone="accent">精选</Badge>}
                    {r.visibility && <Badge tone={r.visibility === "public" ? "muted" : "warn"}>{VISIBILITY_LABEL[r.visibility] ?? r.visibility}</Badge>}
                    {!r.visibility && <Badge>{r.processing_state}</Badge>}
                  </span>
                ),
              },
              { key: "sc", label: "分数", align: "right", render: (r) => r.score ?? "—" },
              { key: "d", label: "发现", render: (r) => <Time at={r.discovered_at} /> },
            ]}
          />
        </Card>
      )}
      {!atEnd && <div ref={sentinel} className="h-12" aria-hidden />}
      {!q && rows.length === 0 && <Empty>输入 ID、链接或标题开始查找。</Empty>}
    </AdminPage>
  );
}
