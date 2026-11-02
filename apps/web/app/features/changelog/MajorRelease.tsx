import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { TerrainCanvas } from "./TerrainCanvas";
import "./major-release.css";

/**
 * 重大更新专题卡：每个 major 一个独立组件函数，写法对照 AIHOT 的重大更新页——
 * 版本大字地形画、导语、编号章节（01/02/03…）、可交互演示、站内入口。
 * 卡片按 dateTtime 选中（changelog.json 里 major 条目的发布时间），未匹配时回落到 2.0。
 */

const TWO_STAGES = [
  ["采集", "找到地理线索", "从机构、台站、期刊与媒体收录公开消息。每一条线索保留来源入口，方便你追溯证据。"],
  ["筛选", "先看位置与证据", "围绕空间影响与信息价值，模型整理中文标题和摘要。阅读网页本身不会触发模型调用。"],
  ["归组", "把来龙去脉串起来", "同一事件的多方报道，放在一条时间线上。你可以从单条消息走向事件，继续查看不同来源。"],
  ["阅读", "从一条动态到一期日报", "精选、全文翻译与日报，让浏览和回顾各有入口。翻译与补刊的完成情况，以具体页面显示为准。"],
  ["接入", "在你的工具里继续读", "网站、RSS、API、MCP，读取同一份公开内容。在阅读器或自己的程序里，也能继续追踪。"],
] as const;

function Journey({ stages }: { stages: typeof TWO_STAGES }) {
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
      {stages.map(([title], index) => <button key={title} type="button" role="tab" id={`${id}-stage-${index}`} aria-controls={`${id}-panel`} aria-selected={stage === index} tabIndex={stage === index ? 0 : -1} onClick={() => setStage(index)}>
        <span className="major-station-number">0{index + 1}</span><span>{title}</span>
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-stage-${stage}`} tabIndex={0} className="major-stage-panel">
      <span className="major-panel-index" aria-hidden="true">0{stage + 1}</span>
      <div><h4>{stages[stage]![1]}</h4><p>{stages[stage]![2]}</p></div>
    </div>
    <noscript><ol>{stages.map(([title, sub, body]) => <li key={title}>{title} · {sub}：{body}</li>)}</ol></noscript>
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

/** 3.0 的可交互演示：一封反馈的旅程（提交 → 直达邮箱 → 可查进度 → 回信直达）。 */
function ReplyJourney() {
  const STAGES = [
    ["提交", "写下想说的话", "反馈页提交正文和截图，留个邮箱；不需要注册，也不需要登录。"],
    ["直达", "实时投进站长邮箱", "每条反馈连同截图实时投进站长的 QQ 邮箱；发送失败自动重试一周，不丢反馈。"],
    ["可查", "随时看处理进度", "凭反馈编号或提交时留的邮箱，在反馈页查询这一条到了哪一步。"],
    ["回信", "答复直达你的邮箱", "站长处理后从邮箱直接回信给你；回信带着你的地址，想继续说就直接回复。"],
  ] as const;
  const [stage, setStage] = useState(0);
  const id = useId();
  return <section className="major-journey">
    <h3 className="text-[20px] font-bold text-ink">一条反馈，走完这四步</h3>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-3">点选一步，看看你的反馈怎么走、怎么回。</p>
    <div className="major-stations" role="tablist" aria-label="反馈的四个阶段" onKeyDown={event => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 3 : (stage + delta + 4) % 4;
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

interface MajorSection { title: string; body: ReactNode }
interface MajorCard { version: string; title: string; lead: string[]; sections: MajorSection[]; links: Array<[string, string]>; body: ReactNode }

/** 2.0：保留原设计的全部内容与交互（Journey + PayloadComparison + 四段）。 */
function MajorTwo(): MajorCard {
  return {
    version: "2.0",
    title: "把世界的地理变化，串成每天读得懂的线索",
    lead: [
      "从建站到现在，GEOHOT 逐步接入地理信源、整理中文内容，再把单条消息串成事件与日报。这次把这些变化放在一起，带你重新认识地理热点。",
      "围绕地理阅读持续改进。这里记录已经实现的能力；历史覆盖和翻译进度，以具体页面显示为准。",
    ],
    sections: [
      { title: "地理，是内容的主线", body: "自然、人文、区域、政治、历史、前沿地理与地理信息系统，七个分类帮助你找到关心的领域。重要消息尽量交代地点、时间、影响范围和来源。" },
      { title: "外文长文，也能接着读", body: "阅读页保留原文入口，并提供中文摘要和全文翻译。长文翻译支持分段续接，科学数字、单位与原文顺序得到专门保护；未完成的内容会显示实际状态。" },
      { title: "今天追踪，也能回看过去", body: "全部动态按日期浏览；事件页汇集多方报道；日报、周报和月报提供另一种回顾方式。历史导入与补刊支持恢复处理，已有内容的日期不会被新收录时间替代。" },
      { title: "阅读之外，留好反馈和接入入口", body: "本地收藏方便下次继续看；反馈可以附截图，站长从管理入口查看。MCP、RSS 与 REST API 向阅读器、Agent 和自己的程序提供匿名只读接入。" },
    ],
    links: [["浏览全部动态", "/all"], ["读地理日报", "/daily"], ["接入你的 Agent", "/agent"]],
    body: <><Journey stages={TWO_STAGES} /><PayloadComparison /></>,
  };
}

/** 1.0：建站里程碑——地理化改版的第一版公开站点。 */
function MajorOne(): MajorCard {
  return {
    version: "1.0",
    title: "地理热点上线：一套为地理而生的阅读站",
    lead: [
      "GEOHOT 从通用框架长成了地理自己的站：信源换成台站、卫星与测绘机构、统计与规划部门、地理学期刊和研究者的公开渠道，筛选标准按空间影响与证据写定，中文标题与摘要、事件归组、每天早上的日报，都为地理重新搭了一遍。",
      "网站、RSS、公开 API 与 MCP 均可匿名使用，不需要注册。",
    ],
    sections: [
      { title: "信源：只收地理的动静", body: "地震、台风、洪水的官方速报，人口与边界的权威数字，地理学期刊的最新研究，做区域研究和野外考察的人写的长文——最快的源 30 分钟看一次，多数源每一到四小时看一次。" },
      { title: "筛选：空间显著性与证据", body: "先看是不是地理的事、有没有实在信息；再按空间显著性打两次分，两次之和过门槛才入选。旅游软文、研学招生、景区通稿挡在门外，这套标准由编辑部写定。" },
      { title: "日报：每天 08:00 出刊", body: "条目按热度排，每条都留着原文地址，方便你回去核对；同一场地震、同一份数据的多家报道并成一个事件，热点榜由此算出。" },
      { title: "公开：同一份数据，处处一致", body: "网页、RSS、公开 API 与 MCP 读同一份公开内容；本站只做摘要与转述、不复制原文全文，原文版权归各台站、机构、期刊和媒体所有。" },
    ],
    links: [["浏览全部动态", "/all"], ["读地理日报", "/daily"], ["了解这个站", "/about"]],
    body: <Journey stages={TWO_STAGES} />,
  };
}

/** 3.0：读者服务闭环——反馈直达邮箱、进度可查、答复直达。 */
function MajorThree(): MajorCard {
  return {
    version: "3.0",
    title: "从读到回信：站点有了完整的读者服务闭环",
    lead: [
      "2.0 把地理消息串成了读得懂的线索；这一个月，我们把「读」延伸成「能对话」——你提交的每条反馈都直达站长邮箱，处理进度随时可查，答复直接回进你的邮箱。全站联系渠道归一为邮箱与反馈页，旧协作通道整链移除。",
      "一个月四十多次更新，这里挑主线；全部明细在下面的时间线里，每条都带版本号。",
    ],
    sections: [
      { title: "反馈直达，进度可查", body: "反馈页提交的正文连同截图实时投进站长邮箱，失败自动重试一周；留了邮箱就能查处理进度，后台回复的邮件带着你的地址，直接回信就能继续对话。" },
      { title: "渠道归一，说的是同一件事", body: "联系邮箱、安全联系文件、隐私说明与使用规则同一口径；精选订阅走 RSS、API 与 MCP，没有多余的推送通道。" },
      { title: "读得更顺，看得更全", body: "日报、周报、月报的条目标题全部可点，图片接上缩放查看器；来源只准摘要的条目也有落地页，标题、导读与原文入口齐全，不再点进 404。" },
      { title: "后台更有力气", body: "正文抽取支持多路并行、逐步留痕；模型门池扩容到十几扇并按官方价每日核对；服务器吃紧时辅助自动让路，读者页面优先。" },
    ],
    links: [["去反馈", "/feedback"], ["查处理进度", "/feedback"], ["看更新日志", "/changelog"]],
    body: <ReplyJourney />,
  };
}

const CARDS: Record<string, () => MajorCard> = {
  "2026-10-24T07:30": MajorTwo,
  "2026-11-01T23:59": MajorThree,
  // 1.0 的发布时间取 changelog.json 里 1.0 时代收束的那条（上线公告）；
  // 站内首条（1.0.0）时间在 2026-09-29 08:00，公告在 10-01 22:40，用公告做 1.0 的卡点。
  "2026-10-01T22:40": MajorOne,
};

export function MajorRelease({ date, time }: { date: string; time: string }) {
  const card = (CARDS[`${date}T${time}`] ?? MajorTwo)();
  return <MajorCardView card={card} date={date} time={time} />;
}

function MajorCardView({ card, date, time }: { card: MajorCard; date: string; time: string }) {
  const article = useRef<HTMLElement>(null);
  const id = useId();
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
        <span className="font-semibold tracking-[0.2em] text-accent">重大更新 · v{card.version} · 置顶</span>
        <time dateTime={`${date}T${time}:00+08:00`} className="text-ink-3">{date.replaceAll("-", " / ")} · {time}</time>
      </div>
      <TerrainCanvas version={card.version} />
      <h2 id={`${id}-title`} className="text-[23px] font-bold leading-[1.45] text-ink sm:text-[28px]">{card.title}</h2>
      {card.lead.map((p, i) => <p key={i} className={`measure ${i === 0 ? "mt-5 text-[15px] leading-[1.9] text-ink-2" : "mt-3 text-[14px] leading-[1.9] text-ink-3"}`}>{p}</p>)}
    </header>
    <div className="space-y-9 px-5 py-7 sm:px-8 sm:py-9">
      {card.body}
      {card.sections.map((s, i) => <section key={s.title} className="border-t border-line-soft pt-7">
        <h3 className="text-[20px] font-bold text-ink"><span className="mr-2 text-[14px] font-medium text-accent">{String(i + 1).padStart(2, "0")}</span>{s.title}</h3>
        <p className="measure mt-3 text-[14px] leading-[1.9] text-ink-3">{s.body}</p>
      </section>)}
      <footer className="flex flex-wrap gap-x-6 gap-y-3 border-t border-line-soft pt-6 text-[14px] font-medium text-accent">{card.links.map(([label, to]) => <Link key={label} to={to}>{label}</Link>)}</footer>
    </div>
  </article>;
}
