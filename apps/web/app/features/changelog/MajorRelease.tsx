import { Link } from "react-router";

const STAGES = [
  ["采集", "找到地理线索", "从机构、台站、期刊与媒体收录公开消息。"],
  ["筛选", "先看位置与证据", "围绕空间影响与信息价值，整理中文标题和摘要。"],
  ["归组", "把来龙去脉串起来", "同一事件的多方报道，放在一条时间线上。"],
  ["阅读", "从一条动态到一期日报", "精选、全文翻译与日报，让浏览和回顾各有入口。"],
  ["接入", "在你的工具里继续读", "网站、RSS、API、MCP，读取同一份公开内容。"],
] as const;

/** Static vector contours keep the feature lightweight and legible without animation or JavaScript. */
function Terrain() {
  return <svg viewBox="0 0 1000 240" className="w-full text-accent" role="img" aria-label="等高线汇成山脊，象征从地理线索到清晰阅读">
    {Array.from({ length: 31 }, (_, i) => {
      const y = 24 + i * 6.2;
      const d = Array.from({ length: 101 }, (_, j) => {
        const x = j * 10;
        const height = 75 * Math.exp(-(((x - 680) / 110) ** 2)) + 43 * Math.exp(-(((x - 860) / 66) ** 2));
        return `${j ? "L" : "M"}${x},${(y - height * Math.sin(Math.PI * i / 34)).toFixed(2)}`;
      }).join(" ");
      return <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={i % 5 === 0 ? 1.4 : 0.7} opacity={i % 5 === 0 ? 0.8 : 0.23} />;
    })}
    <text x="0" y="139" fill="currentColor" fontSize="54" fontWeight="700" letterSpacing="2">GEOHOT</text>
  </svg>;
}

export function MajorRelease({ date, time }: { date: string; time: string }) {
  return <article className="card overflow-hidden" aria-labelledby="major-release-title">
    <header className="bg-accent/5 px-5 pb-7 pt-6 sm:px-8 sm:pb-9">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[12px]">
        <span className="font-semibold tracking-[0.2em] text-accent">重大更新</span>
        <time dateTime={`${date}T${time}:00+08:00`} className="text-ink-3">{date.replaceAll("-", " / ")} · {time}</time>
      </div>
      <div className="my-5 sm:my-7"><Terrain /></div>
      <h2 id="major-release-title" className="text-[23px] font-bold leading-[1.45] text-ink sm:text-[28px]">把世界的地理变化，串成每天读得懂的线索</h2>
      <p className="measure mt-5 text-[15px] leading-[1.9] text-ink-2">从建站到现在，GEOHOT 逐步接入地理信源、整理中文内容，再把单条消息串成事件与日报。这次把这些变化放在一起，带你重新认识地理热点。</p>
      <p className="measure mt-3 text-[14px] leading-[1.9] text-ink-3">基于 AIHOT 开源框架，围绕地理阅读持续改进。这里记录已经实现的能力；历史覆盖和翻译进度，以具体页面显示为准。</p>
    </header>
    <div className="space-y-9 px-5 py-7 sm:px-8 sm:py-9">
      <section>
        <h3 className="text-[20px] font-bold text-ink">一条消息，走过五站</h3>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-5">
          {STAGES.map(([title, sub, body], i) => <div key={title} className="border-t-2 border-accent/30 pt-4">
            <span className="text-[12px] text-accent">0{i + 1}</span>
            <h4 className="mt-2 text-[17px] font-bold text-ink">{title}</h4>
            <p className="mt-1 text-[13px] font-medium text-accent">{sub}</p>
            <p className="mt-2 text-[13px] leading-[1.85] text-ink-3">{body}</p>
          </div>)}
        </div>
      </section>
      {[
        ["地理，是内容的主线", "自然、人文、区域、政治、历史、前沿地理与地理信息系统，七个分类帮助你找到关心的领域。重要消息尽量交代地点、时间、影响范围和来源。"],
        ["外文长文，也能接着读", "阅读页保留原文入口，并提供中文摘要和全文翻译。长文翻译支持分段续接，科学数字、单位与原文顺序得到专门保护；未完成的内容会显示实际状态。"],
        ["今天追踪，也能回看过去", "全部动态按日期浏览；事件页汇集多方报道；日报、周报和月报提供另一种回顾方式。历史导入与补刊支持恢复处理，已有内容的日期不会被新收录时间替代。"],
        ["阅读之外，留好反馈和接入入口", "本地收藏方便下次继续看；反馈可以附截图，站长从管理入口查看。MCP、RSS 与 REST API 向阅读器、Agent 和自己的程序提供匿名只读接入。"],
      ].map(([title, body]) => <section key={title} className="border-t border-line-soft pt-7">
        <h3 className="text-[20px] font-bold text-ink">{title}</h3>
        <p className="measure mt-3 text-[14px] leading-[1.9] text-ink-3">{body}</p>
      </section>)}
      <footer className="flex flex-wrap gap-x-6 gap-y-3 border-t border-line-soft pt-6 text-[14px] font-medium text-accent">
        <Link to="/all">浏览全部动态</Link><Link to="/daily">读地理日报</Link><Link to="/agent">接入你的 Agent</Link>
      </footer>
    </div>
  </article>;
}
