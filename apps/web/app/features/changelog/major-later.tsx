import { useId, useState } from "react";

/**
 * 4.0/5.0/6.0 的专题卡正文：三张卡都用「可点选、可切换」的小演示，
 * 与 2.0 的 Journey、3.0 的 ReplyJourney 保持同一套读法——先看导语，再点一站/切一次，
 * 数字都来自发布当天的实测快照，卡片里写明测量口径。
 */

const GATES = [
  ["来源授权", "只收允许转载全文的站点，其余只留标题与原文入口。"],
  ["完整正文", "正文抽取成功，图片取回或被源站明确拒绝后跳过。"],
  ["中文文案", "标题与摘要已经是中文；外文稿等译文完成再上。"],
  ["相关度", "两次空间显著性打分都过线，旅游通稿不进入。"],
  ["发布门", "精选还要求到点才放行，避免提前露出。"],
] as const;

export function ReadyGates() {
  const [after, setAfter] = useState(true);
  const id = useId();
  return (
    <section className="rounded-2xl border border-line-soft bg-bg-sunk/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[20px] font-bold text-ink">五道门，全过才上线</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">切换看同一天的两组读数：门没补完时，多数条目停在半路。</p>
        </div>
        <div className="flex gap-2" role="group" aria-label="切换上线前后">
          <button type="button" aria-pressed={!after} onClick={() => setAfter(false)} className="rounded-full border border-line-soft px-3 py-1 text-[13px]">补门之前</button>
          <button type="button" aria-pressed={after} onClick={() => setAfter(true)} className="rounded-full border border-line-soft px-3 py-1 text-[13px]">补门之后</button>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {GATES.map(([name, why], index) => (
          <li key={name} id={`${id}-${index}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13.5px]">
            <span className={`w-[64px] shrink-0 font-semibold ${after ? "text-ok" : index === 3 ? "text-amber" : "text-ink-2"}`}>{after ? "已就绪" : index === 3 ? "时好时坏" : "卡住了"}</span>
            <span className="font-medium text-ink">{name}</span>
            <span className="text-ink-3">{why}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[13px] leading-relaxed text-ink-3" aria-live="polite">
        {after
          ? "同一天的「就绪」从 12 条回到 40 条，精选补选不再被隐形条件挡住。"
          : "同一天 249 条候选里只有 12 条真的能读：其余卡在授权、译文或发布门。"}
      </p>
      <p className="mt-2 text-[12px] text-ink-4">口径：2026-11-14 当天 publications 与 article_workflow_readiness 的实际计数。</p>
    </section>
  );
}

const LATENCY = [
  ["境外：Cloudflare 回源", 2100, "2.10 s"],
  ["国内：广州边缘", 110, "0.11 s"],
  ["边缘缓存命中", 0.3, "0.0003 s"],
] as const;

export function LatencyBars() {
  const [open, setOpen] = useState(0);
  return (
    <section className="rounded-2xl border border-line-soft bg-bg-sunk/40 p-5">
      <h3 className="text-[20px] font-bold text-ink">同一个页面，三种到达方式</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">点一条看它慢在哪里；柱子按耗时等比画，最短那条只有一秒的三千分之一。</p>
      <ul className="mt-4 space-y-3">
        {LATENCY.map(([name, ms, label], index) => {
          const width = Math.max(2, (ms / 2100) * 100);
          return (
            <li key={name}>
              <button type="button" onClick={() => setOpen(index)} aria-pressed={open === index} className="block w-full text-left">
                <span className="flex items-baseline justify-between gap-3 text-[13.5px]">
                  <span className="font-medium text-ink">{name}</span>
                  <span className="num text-ink-3">{label}</span>
                </span>
                <span className="mt-1 block h-2 w-full rounded-full bg-bg-muted/50">
                  <span className={`block h-2 rounded-full ${index === 0 ? "bg-amber" : index === 1 ? "bg-accent" : "bg-ok"}`} style={{ width: `${width}%` }} />
                </span>
              </button>
              {open === index && (
                <p className="mt-2 text-[13px] leading-relaxed text-ink-3" aria-live="polite">
                  {index === 0 && "付费版 Cloudflare 的免费线路要绕到大洋彼岸再回源，加速也压不到一秒以内。"}
                  {index === 1 && "国内读者走广州这台边缘，缓存里就有整页，回源只在后台发生。"}
                  {index === 2 && "定时器每 50 秒替你把常用页面走一遍，缓存永远比过期早一步。"}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12px] text-ink-4">口径：2026-11-15 同一分钟、同一路由 `/geohot/` 的三次 curl 计时。</p>
    </section>
  );
}

const SWAP_STEPS = [
  ["发现失败", "正式源连续失败至少五次、至少二十四小时没有成功，而且最近六小时确实尝试过采集。"],
  ["挑同类别", "先找相同分类、一手属性与质量优先级接近的备用源；分类对不上就不强行替换。"],
  ["切换前再验", "被选中的备用源当场再抓一次：标题、链接和最近四百天内的有效日期都要过。"],
  ["一停一启", "同一个事务里停旧启新并写审计；失败源进隔离区，不立刻反复回切。"],
] as const;

export function ReserveSwap() {
  const [step, setStep] = useState(0);
  const id = useId();
  return (
    <section className="rounded-2xl border border-line-soft bg-bg-sunk/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[20px] font-bold text-ink">坏一个，补一个</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">点一步看换源的过程；正式池和备用池始终各留一千条。</p>
        </div>
        <span className="num rounded-full border border-line-soft px-3 py-1 text-[12px] text-ink-3">正式 1,000 · 备用 1,000</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label="换源步骤">
        {SWAP_STEPS.map(([title], index) => (
          <button key={title} type="button" role="tab" id={`${id}-${index}`} aria-selected={step === index}
            aria-controls={`${id}-panel`} tabIndex={step === index ? 0 : -1} onClick={() => setStep(index)}
            className={`rounded-xl border px-3 py-2 text-left text-[13px] ${step === index ? "border-accent bg-surface text-ink" : "border-line-soft bg-surface/60 text-ink-3"}`}>
            <span className="mr-2 text-[11px] font-semibold text-accent">0{index + 1}</span>{title}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${step}`} className="mt-3 rounded-xl bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-ink-2">
        <span className="mr-2 font-semibold text-accent">0{step + 1}</span>{SWAP_STEPS[step]![1]}
      </div>
      <p className="mt-3 text-[12px] text-ink-4">每轮最多换两个，滚动二十四小时最多十二个；失败源达到正式池十分之一时停下等人工。</p>
    </section>
  );
}

const COOLDOWN = [
  ["账号停用", "auth", "换一扇门或重新授权", "提示账号停用，调用不会重试到同一把钥匙上。"],
  ["日额度用完", "quota_day", "次日额度恢复", "当天不再打这扇门，回执保留；额度恢复后自动回到池里。"],
  ["分钟限流", "rate_minute", "下一分钟再试", "只冷却很短一段，不当成配置错误。"],
  ["连接失败", "connect", "网络或上游恢复", "结果未知的回执不盲重放，超过窗口才放行一次。"],
] as const;

export function CooldownBoard() {
  const [open, setOpen] = useState(0);
  return (
    <section className="rounded-2xl border border-line-soft bg-bg-sunk/40 p-5">
      <h3 className="text-[20px] font-bold text-ink">一扇门歇了，池子还在转</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">点一类看它为什么停、什么时候回来；后台把证据时间和恢复条件写在同一个位置。</p>
      <ul className="mt-4 divide-y divide-line-soft">
        {COOLDOWN.map(([name, code, recovery, why], index) => (
          <li key={code}>
            <button type="button" onClick={() => setOpen(index)} aria-pressed={open === index} className="flex w-full flex-wrap items-baseline justify-between gap-2 py-2 text-left text-[13.5px]">
              <span className="font-medium text-ink">{name}</span>
              <span className="font-mono text-[11.5px] text-ink-4">{code}</span>
              <span className="text-ink-3">{recovery}</span>
            </button>
            {open === index && <p className="pb-2 text-[13px] leading-relaxed text-ink-3" aria-live="polite">{why}</p>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-4">回执按逻辑请求缓存；同一条内容要重跑，得让正文变版本或在后台重跑，不会偷偷再付一次。</p>
    </section>
  );
}

const FLEET = [
  ["Azure 主库（国际）", "读者面 + 数据库", "—"],
  ["阿里云 杭州", "协调者 + 采集", "3"],
  ["阿里云 武汉", "内容执行", "2"],
  ["沙箱 box", "内容执行", "2"],
  ["华为云 广州", "执行 + 国内边缘", "2"],
  ["本机（夜间）", "内容执行", "2"],
] as const;

export function FleetGrid() {
  const [night, setNight] = useState(false);
  return (
    <section className="rounded-2xl border border-line-soft bg-bg-sunk/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[20px] font-bold text-ink">五台机器，一条流水线</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">白天保住读者，夜里再放开分析；切换看名额怎么分。</p>
        </div>
        <div className="flex gap-2" role="group" aria-label="切换昼夜档">
          <button type="button" aria-pressed={!night} onClick={() => setNight(false)} className="rounded-full border border-line-soft px-3 py-1 text-[13px]">白天</button>
          <button type="button" aria-pressed={night} onClick={() => setNight(true)} className="rounded-full border border-line-soft px-3 py-1 text-[13px]">夜间</button>
        </div>
      </div>
      <ul className="mt-4 divide-y divide-line-soft">
        {FLEET.map(([name, role, slots]) => (
          <li key={name} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-[13.5px]">
            <span className="font-medium text-ink">{name}</span>
            <span className="text-ink-3">{role}</span>
            <span className="num text-ink-2">{slots === "—" ? "—" : night ? Number(slots) + 1 : slots} 槽</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-3" aria-live="polite">
        {night
          ? "夜间把分析槽加一，磁盘空闲优先级照旧，读者面靠缓存顶着。"
          : "白天的名额按磁盘压力配平：io 一过 60 就把槽收回来，先保首页与「全部」。"}
      </p>
      <p className="mt-2 text-[12px] text-ink-4">口径：2026-11-15 后台「服务器」页读到的心跳与名额。</p>
    </section>
  );
}
