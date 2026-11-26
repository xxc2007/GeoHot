// 模型面板（原 /admin/models 页的主体）：每项能力当前用哪个模型、来自哪里，以及近期的成功率、
// 耗时与上游账单；冷却中的模型；切换记录。并入 /admin/ops?tab=models。
// 与看板重复的部分（实时调用量、费用合计、速度）不再重复一份，这里只留「配置与切换」。
import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import { useEffect } from "react";
import { toCny, cnyInteger } from "@aihot/contracts/cny";
import { useAdminAction } from "../action";
import { bj, num } from "../format";
import { Badge, Button, Card, DataTable, Empty, Field, FilterChips, ReasonDialog, Select } from "../ui";
import { displayCooldown, fmtTime, secondsUntil, type CooldownEntry } from "../cooldown-status";

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

export interface Models {
  days: number;
  fx?: { usdToCny: number; date: string; source: string };
  statistics?: Record<"configuration" | "usage" | "prices" | "history", { state: "ready" | "stale" | "unavailable"; asOf: string | null; message?: string }>;
  capabilities: Array<{ key: string; label: string; env: string; defaultModel: string; vision: boolean; current: { model: string; serving: string; source: "admin" | "env" | "default" }; usage: Usage[] }>;
  choices: Array<{ key: string; service: string; vision: boolean }>;
  history: Array<{ at: string; actor: string; subject: string; reason: string | null; before: { model: string; source: string } | null; after: { model: string; source: string } | null }>;
  cooldowns?: CooldownEntry[];
}

// 取数在 models.server.ts（组件文件不能直接 import `.server`）。

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export function ModelsPanel({ data: m }: { data: Models }) {
  const refresh = useRevalidator();
  useEffect(() => { if (m.statistics?.usage.state === 'ready') return; const id = setInterval(() => { if (document.visibilityState === 'visible' && refresh.state === 'idle') refresh.revalidate(); }, 5000); return () => clearInterval(id); }, [m.statistics?.usage.state, refresh.state, refresh.revalidate]);
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<Models["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-[12.5px] text-ink-3">
        切换只影响之后的新任务，已有结果不重算。池的先后顺序在
        <Link to="?tab=board" className="mx-1 text-accent">实时看板</Link>
        调整；日历与官方价费用在
        <Link to="?tab=usage" className="mx-1 text-accent">用量</Link>。
      </p>
      <FilterChips param="days" options={[{ value: "1", label: "24 小时" }, { value: "", label: "7 天" }, { value: "30", label: "30 天" }]} />
    </div>

    {m.statistics?.usage.state === 'stale' && <p role="status" className="text-[13px] text-ink-3">调用统计显示上次成功结果（{m.statistics.usage.asOf ? bj(m.statistics.usage.asOf) : '—'}），正在后台更新。模型配置按当前设置读取。</p>}
    {Object.entries(m.statistics ?? {}).some(([, s]) => s.state === "unavailable") && (
      <p role="status" className="rounded-control bg-bg-sunk px-4 py-3 text-ui text-ink-3">
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
                  {c.current.serving !== c.current.model && <span className="text-hot-ink">（实际 {c.current.serving}）</span>}
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
                      return <span className={rate < 0.95 ? "text-hot-ink" : ""} title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}>{`${Math.round(rate * 1000) / 10}%`}</span>;
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
                        `${cnyInteger(toCny(u.actualCost, u.currency, m.fx))} 元`
                      ) : u.estimate ? (
                        <span title="按用量 × 单价推算">≈ {cnyInteger(toCny(u.estimate.amount, u.estimate.currency, m.fx))} 元</span>
                      ) : (
                        <span className="whitespace-nowrap text-ink-4" title="服务商未返回实际费用；官方价格折算请查看用量面板">未返回</span>
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

    <Card title="冷却中的模型" pad={false}>
      {m.cooldowns && m.cooldowns.length > 0 ? (
        <DataTable
          dense
          rows={m.cooldowns}
          rowKey={(c) => c.key}
          columns={[
            { key: "model", label: "模型", render: (c) => <span className="whitespace-nowrap font-mono text-[12px]">{c.model}<span className="text-ink-4"> · {c.service}</span></span> },
            { key: "state", label: "状态", render: (c) => { const d = displayCooldown(c); return <Badge tone={d.tone}>{d.label}</Badge>; } },
            { key: "evidence", label: "证据时间", render: (c) => <span className="num whitespace-nowrap text-[12px]">{fmtTime(c.evidenceAt)}</span> },
            { key: "reset", label: "恢复条件", render: (c) => { const d = displayCooldown(c); return <span className="text-[12px] text-ink-2">{d.recovery}</span>; } },
            { key: "remaining", label: "剩余", align: "right", render: (c) => <span className="num whitespace-nowrap text-[12px]">{secondsUntil(c.until)} s</span> },
          ]}
        />
      ) : (
        <div className="p-4"><Empty>当前没有模型被冷却；所有注册成员均按配置健康派发。</Empty></div>
      )}
    </Card>

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
        <div className="p-4"><Empty>{m.statistics?.history.state === "unavailable" ? "切换记录暂时不可用" : "还没有在后台切换过模型"}</Empty></div>
      )}
    </Card>

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
  </>;
}
