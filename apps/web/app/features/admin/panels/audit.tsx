// 审计面板（原 /admin/audit 页的主体）：所有人工操作——谁、何时、改了什么、为什么。
// 并入 /admin/ops?tab=audit；旧地址 302 过来。
import { Form, Link, useSearchParams } from "react-router";
import { bj } from "../format";
import { Button, Card, DataTable, Input, Json } from "../ui";
import { LoadMore, useInfiniteRows } from "../infinite";

export interface AuditRow {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  subject: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

// 取数在 audit.server.ts（组件文件不能直接 import `.server`）。

function subjectLink(subject: string | null) {
  if (!subject) return null;
  const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)];
  if (kind === "content") return <Link className="text-accent" to={`/admin/content/${id}`}>{subject}</Link>;
  if (kind === "source") return <Link className="text-accent" to={`/admin/sources/${encodeURIComponent(id)}`}>{subject}</Link>;
  return <span className="font-mono text-[12px]">{subject}</span>;
}

export function AuditPanel({ data }: { data: { page: number; rows: AuditRow[]; hasMore: boolean } }) {
  const [sp] = useSearchParams();
  const query = new URLSearchParams(sp);
  query.delete("tab");
  const { rows, hasMore, loading, error, loadMore } = useInfiniteRows<AuditRow>("/api/admin/audit", data, query.toString());
  return (
    <>
      <Form method="get" className="flex max-w-xl gap-2">
        <input type="hidden" name="tab" value="audit" />
        <Input name="action" defaultValue={sp.get("action") ?? ""} placeholder="操作前缀，例如 content. 或 source." aria-label="按操作筛选" />
        <Input name="subject" defaultValue={sp.get("subject") ?? ""} placeholder="对象，例如 source:openai-blog" aria-label="按对象筛选" />
        <Button type="submit" tone="primary">筛选</Button>
      </Form>
      <Card pad={false}>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          empty="没有记录"
          columns={[
            { key: "t", label: "时间", className: "whitespace-nowrap", render: (r) => <span className="num whitespace-nowrap">{bj(r.created_at, true)}</span> },
            // 操作名与对象 id 都是不间断的长串：允许换行会把每个字挤成一列（1024 宽的屏上实测），
            // 让它们各自占一行、表格横向滚动，比竖排好读。
            { key: "a", label: "操作", className: "whitespace-nowrap", render: (r) => <span className="font-mono text-[12.5px] text-ink">{r.action}</span> },
            { key: "s", label: "对象", className: "whitespace-nowrap", render: (r) => subjectLink(r.subject) },
            { key: "who", label: "操作人", className: "whitespace-nowrap", render: (r) => r.actor },
            {/* 原因 是唯一允许换行的列，得给它一个下限：其余列 nowrap 之后，它会先被压成一字一行
                （1024 宽实测："Requ eu onc e a gro upi ng…"）。表格本来就横向滚动。 */}
            { key: "r", label: "原因", className: "min-w-[260px]", render: (r) => <span className="text-ink-2">{r.reason}</span> },
            { key: "d", label: "变化", className: "whitespace-nowrap", render: (r) => (r.before || r.after ? <Json value={{ before: r.before, after: r.after }} label="前后" /> : null) },
          ]}
        />
      </Card>
      <LoadMore hasMore={hasMore} loading={loading} error={error} onLoad={loadMore} empty="没有更多了" />
    </>
  );
}
