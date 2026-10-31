import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Form, useSearchParams } from "react-router";
import type { Route } from "./+types/feedback";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { FEEDBACK_STATUS } from "../../features/admin/labels";
import { publicPath } from "../../lib/public-path";
import { safeExternalHref } from "../../lib/safe-url.ts";
import { AdminPage, Badge, Button, Card, Empty, FilterChips, Input, Pager, ReasonDialog, Select, Textarea, Time } from "../../features/admin/ui";

interface Feedback {
  id: number;
  content: string;
  email: string | null;
  page_url: string | null;
  /** local (viewable here until forwarded), feishu (in the internal chat), gone (could not be forwarded), or null. */
  screenshot: "local" | "feishu" | "emailed" | "gone" | null;
  source_hash: string;
  status: string;
  note: string | null;
  forwarded_at: string | null;
  forward_error: string | null;
  created_at: string;
  updated_at: string;
  from_source: number;
  ip: string | null;
  location: string | null;
}

interface Data {
  page: number;
  rows: Feedback[];
  counts: Record<string, number>;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Data>(request, `/api/admin/feedback${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `反馈 · ${SITE.name} 后台` }];

const TONE: Record<string, "accent" | "warn" | "ok" | "muted"> = { new: "accent", triaged: "warn", replied: "ok", resolved: "ok", spam: "muted" };

function FeedbackCard({ f }: { f: Feedback }) {
  const { run, pending } = useAdminAction();
  const [note, setNote] = useState(f.note ?? "");
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [dialog, setDialog] = useState<null | "erase">(null);
  const base = `/api/admin/feedback/${f.id}`;
  // 截图是浏览器自己去取的地址：子路径部署下裸的 `/api/...` 会打到同一台机器上的邻站（见 lib/public-path.ts）。
  const screenshot = publicPath(`${base}/screenshot`);
  // `page_url` 是匿名访客提交的原样字符串：只有 http(s) 才配成为一个链接，其余按纯文本显示（lib/safe-url.ts）。
  const pageHref = safeExternalHref(f.page_url);
  const version = new Date(f.updated_at).toISOString();
  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="num font-medium text-ink-2">#{f.id}</span>
        <Badge tone={TONE[f.status] ?? "muted"}>{FEEDBACK_STATUS[f.status] ?? f.status}</Badge>
        <Time at={f.created_at} />
        <span className="text-ink-4" title={`北京时间 ${bj(f.created_at, true)}`}>{bj(f.created_at)}</span>
        {f.ip && <span className="font-mono text-[11.5px] text-ink-4" title="来源 IP（2026-10-31 起记录）">{f.ip}</span>}
        {f.location && <Badge tone="info" title="按来源 IP 查询的所在地">{f.location}</Badge>}
        {f.email && <a className="text-accent" href={`mailto:${f.email}`}>{f.email}</a>}
        {f.page_url && (pageHref
          ? <a className="max-w-[320px] truncate hover:text-accent" href={pageHref} target="_blank" rel="noreferrer">{f.page_url}</a>
          : <span className="max-w-[320px] truncate text-ink-4" title="这不是一个 http(s) 地址，只作原文显示">{f.page_url}</span>)}
        {f.from_source > 1 && <Badge tone="info" title="同一来源（IP 与浏览器家族的不可逆标识）">同来源 {f.from_source} 条</Badge>}
        {!f.forwarded_at && f.status === "new" && (
          <Badge tone="warn" title={f.forward_error && f.forward_error !== "pending" ? `还没有转发到站长邮箱：${f.forward_error}` : "还没有转发到站长邮箱"}>未转发</Badge>
        )}
      </div>
      <p className="mt-2.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{f.content}</p>
      {f.screenshot === "local" && (
        <a href={screenshot} target="_blank" rel="noreferrer" className="mt-2 inline-block">
          <img src={screenshot} alt="反馈截图" loading="lazy" className="max-h-48 rounded-control ring-1 ring-line" />
        </a>
      )}
      {f.screenshot === "emailed" && <p className="mt-2 text-[12.5px] text-ink-4">截图已随反馈发往站长邮箱。</p>}
      {f.screenshot === "gone" && <p className="mt-2 text-[12.5px] text-ink-4">截图未能随转发上传，已删除。</p>}
      {f.email && (
        <div className="mt-3 rounded-panel bg-bg-sunk p-3 ring-1 ring-line-soft">
          <button type="button" className="text-[13px] font-medium text-accent hover:underline" onClick={() => setReplyOpen(!replyOpen)}>
            {replyOpen ? "收起回复" : "回复读者"}
          </button>
          {replyOpen && (
            <div className="mt-2 space-y-2">
              <Input readOnly value={`收件人：${f.email} · 发件人：${SITE.contactEmail ?? SITE.contactEmail}`} aria-label="回复收发件人" className="!bg-surface text-[12.5px] text-ink-4" />
              <Textarea
                rows={3}
                aria-label="回复正文"
                placeholder={`写给读者 #${f.id} 的回复……发送后状态自动变为「已回复」。`}
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
              />
              <div className="flex justify-end">
                <Button
                  size="md"
                  tone="primary"
                  disabled={replyBody.trim().length < 2 || !!pending}
                  busy={pending === "reply"}
                  onClick={() => run("POST", `${base}/reply`, { body: replyBody }, { label: "reply", success: "回复已发送" }) !== null && setReplyBody("")}
                >
                  用 {SITE.contactEmail ?? "站主邮箱"} 发送
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-start">
        <Select
          aria-label="处理状态"
          value={f.status}
          disabled={!!pending}
          onChange={(e) => run("PATCH", base, { status: e.target.value, version }, { label: "status", success: "状态已更新" })}
        >
          {Object.entries(FEEDBACK_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Textarea rows={1} className="!min-h-[38px]" placeholder="处理备注（仅内部可见）" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex gap-1.5">
          <Button size="md" disabled={note === (f.note ?? "")} busy={pending === "note"} onClick={() => run("PATCH", base, { note: note || null, version }, { label: "note", success: "备注已保存" })}>
            保存备注
          </Button>
          <Button tone="ghost" onClick={() => setDialog("erase")} title="删除这条反馈：列表中直接消失，操作写入审计">删除</Button>
        </div>
      </div>
      <ReasonDialog
        open={dialog === "erase"}
        title="删除这条反馈"
        description="整条从列表中删除（含正文、邮箱、页面地址和截图文件）。不可恢复。原因可填可不填，都会写入审计记录。"
        danger
        requireReason={false}
        confirmLabel="删除"
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/erase`, { reason }, { label: "erase", success: "已删除" })) !== null}
      />
    </article>
  );
}

export default function FeedbackAdmin({ loaderData }: Route.ComponentProps) {
  const { rows, counts, page } = loaderData;
  const [sp] = useSearchParams();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <AdminPage title="反馈" subtitle={`回复用 QQ 邮箱（${SITE.contactEmail ?? "站主邮箱未配置"}）发送，收件人、主题、正文都确认后再发；“已修复上线”要有生产证据。签名统一 ${SITE.name}。`}>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterChips
          param="status"
          options={[{ value: "", label: "全部", count: total }, ...Object.entries(FEEDBACK_STATUS).map(([k, v]) => ({ value: k, label: v, count: counts[k] ?? 0 }))]}
        />
        <Form method="get" className="w-full max-w-xs">
          {sp.get("status") && <input type="hidden" name="status" value={sp.get("status")!} />}
          <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="搜索内容、邮箱、页面" aria-label="搜索反馈" />
        </Form>
      </div>
      <div className="space-y-3">
        {rows.length ? rows.map((f) => <FeedbackCard key={`${f.id}-${f.updated_at}`} f={f} />) : <Card><Empty>没有符合条件的反馈</Empty></Card>}
      </div>
      <Pager page={page} hasMore={rows.length === 50} />
    </AdminPage>
  );
}
