// 板块的图记（plate mark）：四个板块各一枚，取自地图学的老器物——比例尺、经纬网、境界晕线、地层剖面。
// 它们只是图廓上的记号，不承载任何数据：不写坐标、不写图幅编号、不写比例数字（编造这些会变成假事实）。
// 全部 currentColor，最多一处 accent，尺寸与站点图标同一档（16/20/28），跟随 reduced-motion。
export type PlateKind = "scale" | "graticule" | "hachure" | "strata";

const PATHS: Record<PlateKind, React.ReactNode> = {
  // 图解比例尺：交替实心的分划条 + 两端刻线，不标数字。
  scale: (
    <>
      <path d="M3 12h22" strokeWidth="1.25" />
      <path d="M3 8.5v7M9.5 8.5v7M16 8.5v7M22.5 8.5v7" strokeWidth="1.25" />
      <rect x="3" y="10.5" width="3.25" height="3" fill="currentColor" stroke="none" />
      <rect x="9.5" y="10.5" width="3.25" height="3" fill="currentColor" stroke="none" />
      <rect x="16" y="10.5" width="3.25" height="3" fill="currentColor" stroke="none" />
    </>
  ),
  // 经纬之交：与站标同一母题，交叉处一个小圆。
  graticule: (
    <>
      <path d="M14 4v20M4 14h20" strokeWidth="1.25" />
      <circle cx="14" cy="14" r="6.25" strokeWidth="1" strokeDasharray="2 2.5" />
      <circle cx="14" cy="14" r="1.6" fill="var(--accent, currentColor)" stroke="none" />
    </>
  ),
  // 境界晕线：一条界线，单侧短须表示坡向/归属。
  hachure: (
    <>
      <path d="M4 20c4-6 8-9 12-10.5 2.5-1 4.5-1.5 6-1.5" strokeWidth="1.25" />
      <path d="M7.5 16.6l-2.2-2.4M10.6 14.2 8.6 11.6M13.7 12.4l-1.8-2.8M17 10.6l-1.5-3M20.2 9.1l-1.1-3.1" strokeWidth="1" />
    </>
  ),
  // 地层剖面：三层不规则的带，最下一层实心。
  strata: (
    <>
      <path d="M3 10.5c3.5-2 7-2 11 0s7.5 2 11 0" strokeWidth="1.25" />
      <path d="M3 15c3.5-2 7-2 11 0s7.5 2 11 0" strokeWidth="1.25" />
      <path d="M3 19.5c3.5-2 7-2 11 0s7.5 2 11 0" strokeWidth="1.25" />
      <path d="M3 19.5c3.5-2 7-2 11 0s7.5 2 11 0v3.5H3z" fill="currentColor" stroke="none" opacity="0.85" />
    </>
  ),
};

export function PlateMark({ plate, className = "h-7 w-7" }: { plate: PlateKind; className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" focusable="false" className={className} fill="none" stroke="currentColor" strokeLinecap="round">
      {PATHS[plate]}
    </svg>
  );
}
