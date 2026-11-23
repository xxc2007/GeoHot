import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { localeAppPath, useLocale, type Locale } from "../../lib/i18n";
import { majorReleaseCopy } from "../../lib/i18n/pages/major-release";
import { TerrainCanvas } from "./TerrainCanvas";
import { CooldownBoard, FleetGrid, LatencyBars, ReadyGates, ReserveSwap } from "./major-later";
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

const TWO_STAGES_EN = [
  ["Collect", "Find the geographic lead", "Public notices from agencies, stations, journals and media. Every lead keeps its source entrance so you can trace the evidence."],
  ["Select", "Place and evidence first", "Around spatial impact and information value, a model writes the Chinese title and summary. Reading a page never triggers a model call."],
  ["Group", "Join the threads", "Reports of one event share one timeline. You can move from a single report to the event and keep reading other sources."],
  ["Read", "From one update to a daily edition", "Picks, full translations and the daily edition give browsing and looking back their own entrances. Translation and backfill progress are stated on the page."],
  ["Integrate", "Keep reading in your tools", "Website, RSS, API and MCP read the same public content. Follow it in a reader or your own program."],
] as const;

function Journey({ stages }: { stages: ReadonlyArray<readonly [string, string, string]> }) {
  const en = useLocale() === "en";
  const list = en ? TWO_STAGES_EN : stages;
  const [stage, setStage] = useState(0);
  const id = useId();
  // 站数由 stages 决定：2.0 是五站、3.0 是四步。列数写死 5 时四步那组会左对齐剩下半列，
  // 连线又固定画到 90% 宽，于是「04」右边拖出一截没有站点的线；连线只从首站中心画到末站中心。
  const count = list.length;
  const first = 1000 / (count * 2);
  const flowPath = `M${first} 20H${1000 - first}`;
  return <section className="major-journey">
    <h3 className="text-[20px] font-bold text-ink">{en ? "One report, five stations" : "一条消息，走过五站"}</h3>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{en ? "Pick a station to see how a lead becomes readable content." : "点选一站，看看线索如何变成可阅读的内容。"}</p>
    <div className="major-stations" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }} role="tablist" aria-label={en ? `The ${count} stages a report goes through` : `消息的 ${count} 个阶段`} onKeyDown={event => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (stage + delta + count) % count;
      setStage(next); document.getElementById(`${id}-stage-${next}`)?.focus();
    }}>
      <svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true" className="major-flow"><path d={flowPath} className="major-flow-track" /><path d={flowPath} className="major-flow-pulse" /></svg>
      {list.map(([title], index) => <button key={title} type="button" role="tab" id={`${id}-stage-${index}`} aria-controls={`${id}-panel`} aria-selected={stage === index} tabIndex={stage === index ? 0 : -1} onClick={() => setStage(index)}>
        <span className="major-station-number">0{index + 1}</span><span>{title}</span>
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-stage-${stage}`} tabIndex={0} className="major-stage-panel">
      <span className="major-panel-index" aria-hidden="true">0{stage + 1}</span>
      <div><h4>{list[stage]![1]}</h4><p>{list[stage]![2]}</p></div>
    </div>
    <noscript><ol>{list.map(([title, sub, body]) => <li key={title}>{title} · {sub}{en ? ": " : "："}{body}</li>)}</ol></noscript>
  </section>;
}

function PayloadComparison() {
  const en = useLocale() === "en";
  const [tab, setTab] = useState<"payload" | "batch">("payload");
  const [after, setAfter] = useState(true);
  const [more, setMore] = useState(false);
  const id = useId();
  return <section className="major-comparison">
    <div className="major-comparison-heading"><div><h3>{en ? "Lighter on the first screen" : "读到第一屏，更轻一点"}</h3><p>{en ? "The measured payloads from this optimisation, side by side." : "这次优化的实际载荷，放在一起看。"}</p></div><span className="major-snapshot">{en ? "Local measurement snapshot" : "本地测量快照"}</span></div>
    <div className="major-compare-tabs" role="tablist" aria-label={en ? "Speed changes" : "提速变化"} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "payload" : event.key === "End" ? "batch" : tab === "payload" ? "batch" : "payload";
      setTab(next); document.getElementById(`${id}-${next}`)?.focus();
    }}>
      {([["payload", en ? "Home payload" : "首页载荷"], ["batch", en ? "Batched browsing" : "分批浏览"]] as const).map(([key, label]) => <button key={key} type="button" role="tab" id={`${id}-${key}`} aria-controls={`${id}-comparison`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-comparison`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {tab === "payload" ? <div className="major-payload">
        <div className="major-measure-switch" role="group" aria-label={en ? "Switch payload before and after" : "切换优化前后载荷"}><button type="button" aria-pressed={!after} onClick={() => setAfter(false)}>{en ? "Before" : "优化前"} <strong>54,210 B</strong></button><button type="button" aria-pressed={after} onClick={() => setAfter(true)}>{en ? "After" : "优化后"} <strong>20,027 B</strong></button></div>
        <div className="major-bar-track" aria-hidden="true"><div className="major-bar" style={{ width: `${(after ? 20027 / 54210 : 1) * 100}%` }} /></div>
        <p className="major-measure-result" aria-live="polite">{en ? "Home page HTML gzip" : "首页 HTML gzip"} <strong>{after ? "20,027" : "54,210"} B</strong>{after && <span>{en ? "−63.1%" : "减少 63.1%"}</span>}</p>
        <p className="major-measure-note">{en ? "A snapshot of the home page's compressed size under the same controlled fallback data; not server time, and not a China/international network speed test." : "同一受控后备数据条件下的首页压缩体积快照；不是服务器耗时，也不是国内 / 国际线路测速。"}</p>
      </div> : <div className="major-batch">
        <div className="major-batch-heading"><p>{en ? <>Show <strong>12</strong> first, then fetch <strong>40</strong> more as you keep reading.</> : <>先呈现 <strong>12</strong> 条，继续浏览时再取 <strong>40</strong> 条。</>}</p><button type="button" aria-pressed={more} onClick={() => setMore(value => !value)}>{more ? (en ? "Back to the first batch" : "回到首批") : (en ? "Demo loading more" : "演示继续浏览")}</button></div>
        <div className="major-batch-dots" aria-hidden="true">{Array.from({ length: 52 }, (_, index) => <span key={index} data-loaded={index < 12 || more} data-first={index < 12} />)}</div>
        <p aria-live="polite" className="major-measure-result">{more ? (en ? "12 first + 40 later" : "12 条首批 + 40 条后续") : (en ? "12 items in the first batch" : "12 条首批内容")}</p>
        <p className="major-measure-note">{en ? "An illustration of batching; it does not request news or simulate response time here — content still comes from the browsing page." : "分批方式交互示意，不在这里请求新闻或模拟响应耗时；实际内容仍从浏览页继续读取。"}</p>
      </div>}
    </div>
  </section>;
}

/** 3.0 的可交互演示：一封反馈的旅程（提交 → 直达邮箱 → 可查进度 → 回信直达）。 */
function ReplyJourney() {
  const en = useLocale() === "en";
  const STAGES = en ? [
    ["Submit", "Write what you want to say", "Submit text and screenshots on the feedback page and leave an email; no sign-up or login needed."],
    ["Deliver", "Straight into the editor's mailbox", "Each feedback item with its screenshots goes into the editor's QQ mailbox in real time; failed sends retry for a week, so nothing is lost."],
    ["Track", "Check progress any time", "With the feedback number or the email you left, look up how far your item has got on the feedback page."],
    ["Reply", "The answer reaches your inbox", "The editor replies from the mailbox after handling it; the reply carries your address, so replying continues the conversation."],
  ] as const : [
    ["提交", "写下想说的话", "反馈页提交正文和截图，留个邮箱；不需要注册，也不需要登录。"],
    ["直达", "实时投进站长邮箱", "每条反馈连同截图实时投进站长的 QQ 邮箱；发送失败自动重试一周，不丢反馈。"],
    ["可查", "随时看处理进度", "凭反馈编号或提交时留的邮箱，在反馈页查询这一条到了哪一步。"],
    ["回信", "答复直达你的邮箱", "站长处理后从邮箱直接回信给你；回信带着你的地址，想继续说就直接回复。"],
  ] as const;
  const [stage, setStage] = useState(0);
  const id = useId();
  // 四步就是四列、连线只画到「04」的中心：旧写法借用五站的网格与 10%–90% 的连线，
  // 「04」右边会拖出一截没有站点的线。
  const count = STAGES.length;
  const first = 1000 / (count * 2);
  const flowPath = `M${first} 20H${1000 - first}`;
  return <section className="major-journey">
    <h3 className="text-[20px] font-bold text-ink">{en ? "One piece of feedback, four steps" : "一条反馈，走完这四步"}</h3>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{en ? "Pick a step to see how your feedback travels and comes back." : "点选一步，看看你的反馈怎么走、怎么回。"}</p>
    <div className="major-stations" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }} role="tablist" aria-label={en ? `The ${count} stages of feedback` : `反馈的 ${count} 个阶段`} onKeyDown={event => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (stage + delta + count) % count;
      setStage(next); document.getElementById(`${id}-stage-${next}`)?.focus();
    }}>
      <svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true" className="major-flow"><path d={flowPath} className="major-flow-track" /><path d={flowPath} className="major-flow-pulse" /></svg>
      {STAGES.map(([title], index) => <button key={title} type="button" role="tab" id={`${id}-stage-${index}`} aria-controls={`${id}-panel`} aria-selected={stage === index} tabIndex={stage === index ? 0 : -1} onClick={() => setStage(index)}>
        <span className="major-station-number">0{index + 1}</span><span>{title}</span>
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-stage-${stage}`} tabIndex={0} className="major-stage-panel">
      <span className="major-panel-index" aria-hidden="true">0{stage + 1}</span>
      <div><h4>{STAGES[stage]![1]}</h4><p>{STAGES[stage]![2]}</p></div>
    </div>
    <noscript><ol>{STAGES.map(([title, sub, body]) => <li key={title}>{title} · {sub}{en ? ": " : "："}{body}</li>)}</ol></noscript>
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

/** 4.0：读者面把「全流程就绪」真正落成一道门——内容到齐才上线。 */
function MajorFour(): MajorCard {
  return {
    version: "4.0",
    title: "今天的内容，今天就能读到",
    lead: [
      "3.0 把「读」延伸成「能对话」；这两周我们把镜头拉回内容本身：一条消息要经过来源授权、正文、中文文案、相关度与发布门，全过了才出现在读者面前。",
      "门一旦补齐，同一天能读到的条目从 12 条回到 40 条；手机与桌面都不用点「下一页」，一直往下拉就够。",
    ],
    sections: [
      { title: "五道门，缺一道就不上线", body: "抓取、抽取、翻译、打分、发布各有各的判据，任何一条不满足都停在半路；页面只呈现走完整条链的内容。" },
      { title: "精选的补选不再被隐形条件卡住", body: "补选只写了「已精选」，没写放行时间，发布门读到空值时既不放进也不拒绝——一天 248 条就这样卡住，现在补写并回填。" },
      { title: "一直往下拉，不用找下一页", body: "精选、全部、主题页与后台列表都改成触底续读；分页链接只留给不执行脚本的阅读器。" },
      { title: "读不到时给上一版，而不是错误页", body: "收录池与时间线各有一份落盘底稿，缓存过期时先交上一版，再在后台换新。" },
    ],
    links: [["浏览全部动态", "/all"], ["读地理日报", "/daily"], ["看更新日志", "/changelog"]],
    body: <ReadyGates />,
  };
}

/** 5.0：速度——国内走自己的边缘，源站忙时交上一版。 */
function MajorFive(): MajorCard {
  return {
    version: "5.0",
    title: "毫秒级：读者先看到，机器慢慢算",
    lead: [
      "4.0 让内容到齐才上线，代价是后台把磁盘写满时读者会等；这一次我们把「等」从读者身上移走：缓存铺到五层，页面由定时器保温，国内读者走广州的边缘。",
      "同一分钟同一路由：境外经 Cloudflare 回源 2.10 秒，国内边缘 0.11 秒，缓存命中 0.0003 秒。",
    ],
    sections: [
      { title: "五层缓存，一层比一层近", body: "nginx 旧页兜底、收录池与时间线的落盘底稿、进程内订阅源缓存、边缘反代、浏览器缓存，任意一层命中都不必碰数据库。" },
      { title: "定时器替读者先走一遍", body: "首页与「全部」每 50 秒预热一次，缓存 120 秒永远比过期早一步；边缘再叠一层自己的保温。" },
      { title: "国内有边缘，境外有主库", body: "广州这台机器缓存反代回主库，只回源不连库；主库发布新版本后，边缘最多两分钟自动跟上。" },
      { title: "慢盘上也让路", body: "后台进程降成磁盘空闲优先级，备份改成 ionice 并跳过两张最大的表；io 一过 60 就把分析槽收回来。" },
    ],
    links: [["浏览全部动态", "/all"], ["看热点榜", "/hot"], ["看更新日志", "/changelog"]],
    body: <LatencyBars />,
  };
}

/** 6.0：多机协同——五台机器分工、自愈与昼夜窗口。 */
function MajorSix(): MajorCard {
  return {
    version: "6.0",
    title: "五台机器，一条流水线",
    lead: [
      "5.0 解决「快」，这一版解决「一直快」：主库只管读者面，四台执行器按角色分工，白天收着跑、夜里放开跑，坏了自己回来。",
      "后台「服务器」页能同时看到每台机器的 CPU、内存、磁盘、单元状态与心跳，离线也留着位置。",
    ],
    sections: [
      { title: "角色分工，各司其职", body: "协调者登记采集与定时任务，执行器只领分析与抽取，取图单独一路；每个角色只注册自己该领的队列。" },
      { title: "昼夜窗口与磁盘压力", body: "23:00 放开分析、07:00 收回；io 超过阈值就不再增加名额，读者面出现 5xx 立即退回上一档。" },
      { title: "闸门只挡新活，不杀在飞", body: "读者面 5xx 连续命中时不再重启进程，只冻结领新任务；部署窗口内的 5xx 不计入，避免自己把自己判成故障。" },
      { title: "自愈写进单元里", body: "隧道重启不设上限、执行器失败自动重试、保活用独立会话；备份与部署在慢盘上先等安静，再动手。" },
    ],
    links: [["看服务器状态", "/admin/server"], ["了解这个站", "/about"], ["看更新日志", "/changelog"]],
    body: <FleetGrid />,
  };
}

/** 7.0：信源池——正式一千、备用一千，坏掉的入口由核验过的候选顶上。 */
function MajorSeven(): MajorCard {
  return {
    version: "7.0",
    title: "两千个信源，坏一个补一个",
    lead: [
      "6.0 让五台机器各司其职，这一版把信源池做成一本能自己平账的账：正式采集一千条，备用候选一千条；坏掉的入口不再永远占着位置。",
      "备用只收公开 RSS 与 JSON 入口；复核是只读探测，不写文章，也不调用模型。",
    ],
    sections: [
      { title: "一千加一千，不是两千个名字", body: "正式池持续采集，备用池只做候选；同一个地址不能同时出现在两边。没有文章引用的旧入口移出运行池，历史归档不冒充可用池。" },
      { title: "每五分钟，最多复核四个", body: "备用源要有标题、链接和最近四百天内的有效日期；合格的才显示为“备用可用”，隔离或归档的不算进池。" },
      { title: "换源先看证据", body: "正式源连续失败至少五次、至少二十四小时没有成功、最近六小时确实尝试过，才进入替换；预算、限流与 429 不触发替换。" },
      { title: "换多少也有闸门", body: "每轮最多换两个，滚动二十四小时最多十二个；失败源达到正式池十分之一就停下等人工。切换在同一事务里一停一启，失败源先进隔离区。" },
    ],
    links: [["看信源池", "/admin/sources"], ["看更新日志", "/changelog"], ["了解这个站", "/about"]],
    body: <ReserveSwap />,
  };
}

/** 8.0：模型账本——计费口径、价卡版本、冷却恢复与后台慢查询。 */
function MajorEight(): MajorCard {
  return {
    version: "8.0",
    title: "每一笔模型调用，都有一本明白账",
    lead: [
      "这一版把模型调用和后台状态做成可核对的账：订阅、免费、无公开价与公开 API 刊例分开记；价卡带版本，冷却写清恢复条件。",
      "后台不再用假的零或永远的“正在生成”掩盖慢查询；旧数据保留，并标明它是什么时候的。",
    ],
    sections: [
      { title: "五种口径，各记各的", body: "公开 API 刊例只做等值估算，订阅、免费、无公开价与未核实分别标出；上游实报只来自回执，不把估算写成 actual，也不把未返回费用当成免费。" },
      { title: "价卡有版本，汇率每天核对", body: "四十七条映射随迁移落库；每次调用按当时有效的价卡折算。价卡核对放在每天清晨，基准值消失或改版就标记待复核，保留最后成功价，不自动猜新价。" },
      { title: "冷却不是拉黑", body: "账号停用、日额度、分钟限流、连接失败与配置缺失分开处理，各自写明恢复时间与条件；结果未知的回执不盲重放，超过窗口才放行一次。" },
      { title: "后台慢，但不装死", body: "运行页先给实时心跳与队列，详细统计在后台补；用量首次生成不再把“不可用”缓存一分钟。读者机内存与后台静态资源单独处理，读者面仍排在前面。" },
    ],
    links: [["看用量总览", "/admin/usage"], ["看模型池", "/admin/models"], ["看更新日志", "/changelog"]],
    body: <CooldownBoard />,
  };
}

/** 9.0 的可交互演示：同一块界面切一次语言，看看中英两版各是什么读法。示例文字仅作演示，不指向真实事件。 */
function LangDemo() {
  const pageEn = useLocale() === "en";
  const [en, setEn] = useState(pageEn);
  return (
    <section className="rounded-2xl border border-line-soft bg-bg-sunk/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[20px] font-bold text-ink">{pageEn ? "One interface, two readings" : "一块界面，两种读法"}</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{pageEn ? "Click a language pill to see the site after switching to English." : "点一下语言胶囊，看看站点切换成英文后是什么样。"}</p>
        </div>
        <div className="flex gap-2" role="group" aria-label={pageEn ? "Chinese/English demo switch" : "切换中英文演示"}>
          <button type="button" aria-pressed={!en} onClick={() => setEn(false)} className="rounded-full border border-line-soft px-3 py-1 text-[13px]">{pageEn ? "Chinese" : "中文"}</button>
          <button type="button" aria-pressed={en} onClick={() => setEn(true)} className="rounded-full border border-line-soft px-3 py-1 text-[13px]">English</button>
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-line-soft bg-bg p-4" aria-live="polite">
        <p className="text-[11px] tracking-[0.2em] text-ink-4">{en ? "GEOHOT · ENGLISH EDITION" : "GEOHOT · 中文界面"}</p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] font-medium text-ink-2">
          {(en ? ["Featured", "All", "Daily", "More"] : ["精选", "全部", "日报", "更多"]).map(label => <span key={label}>{label}</span>)}
        </div>
        <p className="mt-3 text-[15px] font-semibold text-ink">{en ? "M6.4 earthquake strikes off the coast of …" : "近海发生 6.4 级地震（整理标题示例）"}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{en ? "The headline is shown as the source published it." : "英文页优先显示信源原题与原文正文。"}</p>
      </div>
      <p className="mt-3 text-[12px] text-ink-4">{pageEn ? "Sample text is for demonstration only and points to no real event." : "示例文字仅作演示，不指向真实事件。"}</p>
    </section>
  );
}

/** 9.0：英文版界面框架上线——整站可切中英文，英文页优先显示信源原题与原文正文。 */
function MajorNine(): MajorCard {
  return {
    version: "9.0",
    title: "英文版界面上线，站点能切换中英文",
    lead: [
      "地理消息不分语言。站点现在有了英文版：导航、按钮与页面说明都能切换成英文；读国际机构的通报，英文页优先显示信源原题与原文正文。",
      "英文版上线时还在起步：AI 摘要与日报当时仍是中文，页面会如实标注；覆盖进度以更新日志为准。",
    ],
    sections: [
      { title: "一处开关，随时切换语言", body: "侧边栏与「更多」页各有一枚语言开关，一键在中英文之间互换；英文页面挂在 /en 前缀下，熟悉的地址前面加上 /en 就能直达。" },
      { title: "英文页，先读原题与原文", body: "国际信源的通报多以外文写成：英文版优先显示信源原题与原文正文，少一层转述；没有原题的条目仍显示整理标题。" },
      { title: "中文内容，当时如实标注", body: "英文版上线时，AI 摘要与日报由中文整理生成，在英文版里保持中文并明确标注；界面是英文的，内容是哪种语言就说是哪种。" },
      { title: "同一份数据，两种读法", body: "英文版与中文版读同一份公开内容：精选、动态、日报、专题与反馈入口一一对齐，切换语言不打断你正在读的页面。" },
    ],
    links: [["浏览全部动态", "/all"], ["去英文版首页", "/en"], ["看更新日志", "/changelog"]],
    body: <LangDemo />,
  };
}

const CARDS: Record<string, () => MajorCard> = {
  "2026-11-22T18:05": MajorNine,
  "2026-11-20T22:40": MajorEight,
  "2026-11-20T22:30": MajorSeven,
  "2026-11-15T13:00": MajorSix,
  "2026-11-15T12:50": MajorFive,
  "2026-11-15T12:40": MajorFour,
  "2026-10-24T07:30": MajorTwo,
  "2026-11-01T23:59": MajorThree,
  // 1.0 的发布时间取 changelog.json 里 1.0 时代收束的那条（上线公告）；
  // 站内首条（1.0.0）时间在 2026-09-29 08:00，公告在 10-01 22:40，用公告做 1.0 的卡点。
  "2026-10-01T22:40": MajorOne,
};

export function MajorRelease({ date, time }: { date: string; time: string }) {
  const locale = useLocale();
  const base = (CARDS[`${date}T${time}`] ?? MajorTwo)();
  // /en：标题、导语、章节与入口链接取字典里的英文；交互演示仍是那张卡的中文版式（顶部已注明）。
  // 字典缺这张卡（未来新增的 major）时整张保留中文并由 changelog 页的 MissingEnglishNotice 说明。
  const english = majorReleaseCopy(locale)?.cards[`${date}T${time}`];
  const card = english ? { ...base, ...english } : base;
  return <MajorCardView card={card} date={date} time={time} />;
}

/**
 * A card entry's target. `"/admin"` has no `/en` twin (the admin keeps Chinese), and `"/en"` is the
 * card's own "go to the English home" entry — an explicit language switch, not a page of the current
 * language. `localeAppPath("/en", "zh")` would fold it to `/` (the Chinese home), so both stay as written.
 */
function cardHref(to: string, locale: Locale): string {
  if (to.startsWith("/admin") || to === "/en") return to;
  return localeAppPath(to, locale);
}

function MajorCardView({ card, date, time }: { card: MajorCard; date: string; time: string }) {
  const locale = useLocale();
  const chrome = majorReleaseCopy(locale)?.chrome ?? null;
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
        <span className="font-semibold tracking-[0.2em] text-accent">{chrome ? chrome.kicker(card.version) : `重大更新 · v${card.version} · 置顶`}</span>
        <time dateTime={`${date}T${time}:00+08:00`} className="text-ink-3">{date.replaceAll("-", " / ")} · {time}</time>
      </div>
      <TerrainCanvas version={card.version} label={chrome ? `GEOHOT ${card.version} animated contour map` : undefined} />
      <h2 id={`${id}-title`} className="text-[23px] font-bold leading-[1.45] text-ink sm:text-[28px]">{card.title}</h2>
      {card.lead.map((p, i) => <p key={i} className={`measure ${i === 0 ? "mt-5 text-[15px] leading-[1.9] text-ink-2" : "mt-3 text-[14px] leading-[1.9] text-ink-3"}`}>{p}</p>)}
    </header>
    <div className="space-y-9 px-5 py-7 sm:px-8 sm:py-9">
      {card.body}
      {card.sections.map((s, i) => <section key={s.title} className="border-t border-line-soft pt-7">
        <h3 className="text-[20px] font-bold text-ink"><span className="mr-2 text-[14px] font-medium text-accent">{String(i + 1).padStart(2, "0")}</span>{s.title}</h3>
        <p className="measure mt-3 text-[14px] leading-[1.9] text-ink-3">{s.body}</p>
      </section>)}
      {/* 卡片的入口链接文案随卡片语言（/en 用字典里译好的标签），站内去处随页面语言带前缀；
          /admin 没有 /en 路由、"/en" 是显式语言入口（见 cardHref），两者都保持原样。 */}
      <footer className="flex flex-wrap gap-x-6 gap-y-3 border-t border-line-soft pt-6 text-[14px] font-medium text-accent">{card.links.map(([label, to]) => <Link key={label} to={cardHref(to, locale)}>{label}</Link>)}</footer>
    </div>
  </article>;
}
