import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import {Link,useRevalidator} from "react-router";
import {useEffect} from "react";
import {toCny,cnyInteger} from "@aihot/contracts/cny";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, ReasonDialog, Select } from "../../features/admin/ui";

interface Usage {
  purpose: string;
  service: string;
  model: string | null;
  promptVersion: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokensIn: number;
  tokensOut: number;
  actualCost: number | null;
  currency: string | null;
  estimate: { amount: number; currency: string } | null;
}

interface Models {
  days: number;
  statistics?: Record<"configuration" | "usage" | "prices" | "history", { state: "ready" | "stale" | "unavailable"; asOf: string | null; message?: string }>;
  capabilities: Array<{ key: string; label: string; env: string; defaultModel: string; vision: boolean; current: { model: string; serving: string; source: "admin" | "env" | "default" }; usage: Usage[] }>;
  choices: Array<{ key: string; service: string; vision: boolean }>;
  history: Array<{ at: string; actor: string; subject: string; reason: string | null; before: { model: string; source: string } | null; after: { model: string; source: string } | null }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  return adminGet<Models>(request, `/api/admin/models?days=${encodeURIComponent(days)}`);
}

export const meta: Route.MetaFunction = () => [{ title: `模型 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const refresh=useRevalidator();
  useEffect(()=>{if(m.statistics?.usage.state==='ready')return;const id=setInterval(()=>{if(document.visibilityState==='visible'&&refresh.state==='idle')refresh.revalidate();},5000);return()=>clearInterval(id);},[m.statistics?.usage.state,refresh.state,refresh.revalidate]);
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<Models["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="模型"
      subtitle={<>每项能力当前用哪个模型、来自哪里，以及近期的成功率、耗时与上游账单。切换只影响之后的新任务，已有结果不重算。<Link to="/admin/usage" className="ml-1 text-accent">官方价费用见用量总览。</Link></>}
      actions={<FilterChips param="days" options={[{ value: "1", label: "24 小时" }, { value: "", label: "7 天" }, { value: "30", label: "30 天" }]} />}
    >
      {m.statistics?.usage.state==='stale'&&<p role="status" className="mb-4 text-[13px] text-ink-3">调用统计显示上次成功结果（{m.statistics.usage.asOf?bj(m.statistics.usage.asOf):'—'}），正在后台更新。模型配置按当前设置读取。</p>}
      {Object.entries(m.statistics ?? {}).some(([, s]) => s.state === "unavailable") && (
        <p role="status" className="mb-5 rounded-control bg-bg-sunk px-4 py-3 text-ui text-ink-3">
          {m.statistics?.configuration?.state === "unavailable" ? "当前模型配置暂时不可用，请稍后刷新。" : "部分统计暂时不可用，请稍后刷新。当前模型配置仍可查看。"}
          未加载的统计不代表没有调用或记录。
        </p>
      )}
      <div className="grid gap-5">
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.label}
                  <span className="font-mono text-[12px] font-normal text-ink-3">
                    {c.current.model}
                    {/* A pool can list members that cannot serve (no key, no JSON mode). Showing only the
                        configured string would claim capacity that is not there. */}
                    {c.current.serving !== c.current.model && <span className="text-hot">（实际 {c.current.serving}）</span>}
                  </span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                </span>
              }
              right={
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(c);
                    // A pool is an environment setting and the dropdown has no entry for it. Preselecting
                    // 恢复默认 is the honest preselect — submitting it removes the admin override, which is
                    // exactly what leaves the env pool in charge.
                    setChoice(m.choices.some((x) => x.key === c.current.model) ? c.current.model : "__default");
                  }}
                >
                  切换
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.purpose}|${u.service}|${u.model}|${u.promptVersion}`}
                  columns={[
                    // The provider is shown as well as the model: two endpoints can answer under one model name,
                    // and a pool whose traffic is invisible looks like a single provider carrying everything.
                    { key: "m", label: "模型", render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}<span className="text-ink-4"> · {u.service}</span></span> },
                    { key: "v", label: "提示版本", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span> },
                    { key: "p", label: "用途", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: "调用", align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: "成功率",
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return <span className={rate < 0.95 ? "text-hot" : ""} title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}>{`${Math.round(rate * 1000) / 10}%`}</span>;
                      },
                    },
                    { key: "l", label: "耗时 p50 / p95", align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                    { key: "t", label: "输入 / 输出 token", align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                    {
                      key: "$",
                      label: "上游账单",
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${cnyInteger(toCny(u.actualCost,u.currency))} 元`
                        ) : u.estimate ? (
                          <span title="按用量 × 单价推算">≈ {cnyInteger(toCny(u.estimate.amount,u.estimate.currency))} 元</span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-4" title="服务商未返回实际费用；官方价格折算请查看用量总览">未返回</span>
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>{m.statistics?.usage.state === "unavailable" ? "调用统计暂时不可用" : <>{m.days} 天内没有调用{total === 0 && c.vision ? "（只在有图片时使用）" : ""}</>}</Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="切换记录" pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: "时间", render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: "能力", render: (h) => labelOf(h.subject) },
                { key: "m", label: "变化", render: (h) => <span className="font-mono text-[12px]">{h.before?.model ?? "—"} → {h.after?.model ?? "—"}</span> },
                { key: "r", label: "原因", render: (h) => <span className="text-ink-3">{h.reason}</span> },
                { key: "a", label: "操作人", render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>{m.statistics?.history.state === "unavailable" ? "切换记录暂时不可用" : "还没有在后台切换过模型"}</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={`切换模型：${target?.label ?? ""}`}
        description="只影响之后的新任务。选“恢复默认”会回到环境变量或代码默认。"
        confirmLabel="切换"
        busy={pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) =>
          (await run("POST", `/api/admin/models/${target!.key}`, { model: choice === "__default" ? null : choice, reason }, { label: "switch", success: "已切换，下一次调用生效" })) !== null
        }
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {m.choices
              .filter((x) => x.vision === !!target?.vision)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.key}（{x.service}）
                </option>
              ))}
            <option value="__default">恢复默认（{target?.env} 或 {target?.defaultModel}）</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
