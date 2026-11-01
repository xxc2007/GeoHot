import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { TerrainCanvas } from "./TerrainCanvas";
import "./major-release.css";

const STAGES = [
  ["采集", "找到地理线索", "从机构、台站、期刊与媒体收录公开消息。每一条线索保留来源入口，方便你追溯证据。"],
  ["筛选", "先看位置与证据", "围绕空间影响与信息价值，模型整理中文标题和摘要。阅读网页本身不会触发模型调用。"],
  ["归组", "把来龙去脉串起来", "同一事件的多方报道，放在一条时间线上。你可以从单条消息走向事件，继续查看不同来源。"],
  ["阅读", "从一条动态到一期日报", "精选、全文翻译与日报，让浏览和回顾各有入口。翻译与补刊的完成情况，以具体页面显示为准。"],
  ["接入", "在你的工具里继续读", "网站、RSS、API、MCP，读取同一份公开内容。在阅读器或自己的程序里，也能继续追踪。"],
] as const;

function Journey() {
  const [stage, setStage] = useState(0);
  const id = useId();
  return <section className="major-journey">
    <h3 className="text-[20px] font-bold text-ink">一条消息，走过五站</h3>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-3">点选一站，看看线索如何变成可阅读的内容。</p>
    <div className="major-stations" role="tablist" aria-label="消息的五个阶段" onKeyDown={event => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 4 : (stage + delta + 5) % 5;
      setStage(next); document.getElementById(`${id}-stage-${next}`)?.focus();
    }}>
      <svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true" className="major-flow"><path d="M100 20H900" className="major-flow-track" /><path d="M100 20H900" className="major-flow-pulse" /></svg>
      {STAGES.map(([title], index) => <button key={title} type="button" role="tab" id={`${id}-stage-${index}`} aria-controls={`${id}-panel`} aria-selected={stage === index} tabIndex={stage === index ? 0 : -1} onClick={() => setStage(index)}>
        <span className="major-station-number">0{index + 1}</span><span>{title}</span>
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-stage-${stage}`} tabIndex={0} className="major-stage-panel">
      <span className="major-panel-index" aria-hidden="true">0{stage + 1}</span>
      <div><h4>{STAGES[stage]![1]}</h4><p>{STAGES[stage]![2]}</p></div>
    </div>
    <noscript><ol>{STAGES.map(([title, sub, body]) => <li key={title}>{title} · {sub}：{body}</li>)}</ol></noscript>
  </section>;
}

function PayloadComparison() {
  const [tab, setTab] = useState<"payload" | "batch">("payload");
  const [after, setAfter] = useState(true);
  const [more, setMore] = useState(false);
  const id = useId();
  return <section className="major-comparison">
    <div className="major-comparison-heading"><div><h3>读到第一屏，更轻一点</h3><p>这次优化的实际载荷，放在一起看。</p></div><span className="major-snapshot">本地测量快照</span></div>
    <div className="major-compare-tabs" role="tablist" aria-label="提速变化" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "payload" : event.key === "End" ? "batch" : tab === "payload" ? "batch" : "payload";
      setTab(next); document.getElementById(`${id}-${next}`)?.focus();
    }}>
      {([["payload", "首页载荷"], ["batch", "分批浏览"]] as const).map(([key, label]) => <button key={key} type="button" role="tab" id={`${id}-${key}`} aria-controls={`${id}-comparison`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-comparison`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {tab === "payload" ? <div className="major-payload">
        <div className="major-measure-switch" role="group" aria-label="切换优化前后载荷"><button type="button" aria-pressed={!after} onClick={() => setAfter(false)}>优化前 <strong>54,210 B</strong></button><button type="button" aria-pressed={after} onClick={() => setAfter(true)}>优化后 <strong>20,027 B</strong></button></div>
        <div className="major-bar-track" aria-hidden="true"><div className="major-bar" style={{ width: `${(after ? 20027 / 54210 : 1) * 100}%` }} /></div>
        <p className="major-measure-result" aria-live="polite">首页 HTML gzip <strong>{after ? "20,027" : "54,210"} B</strong>{after && <span>减少 63.1%</span>}</p>
        <p className="major-measure-note">同一受控后备数据条件下的首页压缩体积快照；不是服务器耗时，也不是国内 / 国际线路测速。</p>
      </div> : <div className="major-batch">
        <div className="major-batch-heading"><p>先呈现 <strong>12</strong> 条，继续浏览时再取 <strong>40</strong> 条。</p><button type="button" aria-pressed={more} onClick={() => setMore(value => !value)}>{more ? "回到首批" : "演示继续浏览"}</button></div>
        <div className="major-batch-dots" aria-hidden="true">{Array.from({ length: 52 }, (_, index) => <span key={index} data-loaded={index < 12 || more} data-first={index < 12} />)}</div>
        <p aria-live="polite" className="major-measure-result">{more ? "12 条首批 + 40 条后续" : "12 条首批内容"}</p>
        <p className="major-measure-note">分批方式交互示意，不在这里请求新闻或模拟响应耗时；实际内容仍从浏览页继续读取。</p>
      </div>}
    </div>
  </section>;
}

/** 每个重大更新（major: true）一张卡：标题、导语、要点与入口都写在数据里，组件只负责展示。 */
const MAJOR_RELEASES: Record<string, {
  title: string;
  lead: string;
  note: string;
  sections: Array<[string, string]>;
  links: Array<[string, string]>;
  showJourney?: boolean;
}> = {
  "2026-10-24T07:30": {
    title: "把世界的地理变化，串成每天读得懂的线索",
    lead: "从建站到现在，GEOHOT 逐步接入地理信源、整理中文内容，再把单条消息串成事件与日报。这次把这些变化放在一起，带你重新认识地理热点。",
    note: "围绕地理阅读持续改进。这里记录已经实现的能力；历史覆盖和翻译进度，以具体页面显示为准。",
    sections: [
      ["地理，是内容的主线", "自然、人文、区域、政治、历史、前沿地理与地理信息系统，七个分类帮助你找到关心的领域。重要消息尽量交代地点、时间、影响范围和来源。"],
      ["外文长文，也能接着读", "阅读页保留原文入口，并提供中文摘要和全文翻译。长文翻译支持分段续接，科学数字、单位与原文顺序得到专门保护；未完成的内容会显示实际状态。"],
      ["今天追踪，也能回看过去", "全部动态按日期浏览；事件页汇集多方报道；日报、周报和月报提供另一种回顾方式。历史导入与补刊支持恢复处理，已有内容的日期不会被新收录时间替代。"],
      ["阅读之外，留好反馈和接入入口", "本地收藏方便下次继续看；反馈可以附截图，站长从管理入口查看。MCP、RSS 与 REST API 向阅读器、Agent 和自己的程序提供匿名只读接入。"],
    ],
    links: [["浏览全部动态", "/all"], ["读地理日报", "/daily"], ["接入你的 Agent", "/agent"]],
    showJourney: true,
  },
  "2026-11-01T23:59": {
    title: "从读到回信：站点有了完整的读者服务闭环",
    lead: "2.0 把地理消息串成了读得懂的线索；这一个月，我们把「读」延伸成「能对话」——你提交的每条反馈都直达站长邮箱，处理进度随时可查，答复直接回进你的邮箱。",
    note: "一个月 40 多次更新，这里挑四条主线。全部明细在下面的时间线里，每条都带版本号。",
    sections: [
      ["反馈直达，进度可查", "反馈页提交的内容连同截图实时投进站长邮箱，失败自动重试；留了邮箱就能查处理进度，后台回复的邮件带着你的地址，直接回信就能继续对话。"],
      ["渠道归一，说的是同一件事", "联系邮箱、安全联系文件、隐私说明与使用规则同一口径；没有内部聊天工具，也没有多余的推送通道，全站联系渠道只有邮箱和反馈页。"],
      ["读得更顺，看得更全", "日报、周报、月报的条目标题全部可点，图片接上缩放查看器；来源只准摘要的条目也有落地页，标题、导读与原文入口齐全，不再点进 404。"],
      ["后台更有力气", "正文抽取支持多路并行、逐步留痕；模型门池扩容到十几扇并按官方价每日核对；服务器吃紧时辅助自动让路，读者页面优先。"],
    ],
    links: [["去反馈", "/feedback"], ["读更新日志", "/changelog"], ["浏览全部动态", "/all"]],
  },
};

export function MajorRelease({ date, time }: { date: string; time: string }) {
  const article = useRef<HTMLElement>(null);
  const id = useId();
  const content = MAJOR_RELEASES[`${date}T${time}`] ?? Object.values(MAJOR_RELEASES)[0]!;
  useEffect(() => {
    const element = article.current;
    if (!element) return;
    let visible = false;
    const sync = () => { element.dataset.active = String(visible && !document.hidden); };
    const observer = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; sync(); });
    observer.observe(element); document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); };
  }, []);
  return <article ref={article} className="major-release card overflow-hidden" aria-labelledby={`${id}-title`}>
    <header className="bg-accent/5 px-5 pb-7 pt-6 sm:px-8 sm:pb-9">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[12px]">
        <span className="font-semibold tracking-[0.2em] text-accent">重大更新 · 置顶</span>
        <time dateTime={`${date}T${time}:00+08:00`} className="text-ink-3">{date.replaceAll("-", " / ")} · {time}</time>
      </div>
      {content.showJourney && <TerrainCanvas />}
      <h2 id={`${id}-title`} className="text-[23px] font-bold leading-[1.45] text-ink sm:text-[28px]">{content.title}</h2>
      <p className="measure mt-5 text-[15px] leading-[1.9] text-ink-2">{content.lead}</p>
      <p className="measure mt-3 text-[14px] leading-[1.9] text-ink-3">{content.note}</p>
    </header>
    <div className="space-y-9 px-5 py-7 sm:px-8 sm:py-9">
      {content.showJourney && <Journey />}{content.showJourney && <PayloadComparison />}
      {content.sections.map(([title, body]) => <section key={title} className="border-t border-line-soft pt-7"><h3 className="text-[20px] font-bold text-ink">{title}</h3><p className="measure mt-3 text-[14px] leading-[1.9] text-ink-3">{body}</p></section>)}
      <footer className="flex flex-wrap gap-x-6 gap-y-3 border-t border-line-soft pt-6 text-[14px] font-medium text-accent">{content.links.map(([label, to]) => <Link key={to} to={to}>{label}</Link>)}</footer>
    </div>
  </article>;
}
