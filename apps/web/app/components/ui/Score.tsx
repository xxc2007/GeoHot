/**
 * The AI score as a small pill, tinted by tier instead of drawn as a bar: strong picks (85+) in a wash of
 * warm red, solid ones (70+) in the accent, the rest as quiet text. The score itself is unchanged.
 */
const TIERS = [
  { min: 85, className: "bg-hot/10 text-hot-ink ring-hot/25" },
  { min: 70, className: "bg-accent-soft text-accent ring-accent/20" },
  { min: 0, className: "text-ink-4 ring-line-soft" },
];

/**
 * "入选分 · 88" on desktop cards; `compact` keeps only the number (phones). The pill is a labelled image:
 * an `aria-label` on a bare <span> is dropped by assistive tech, so without `role="img"` a screen reader
 * announces only "88" (or nothing at all in compact mode, where 88 is the whole pill).
 *
 * 措辞是本站相对上游的刻意偏离：上游那一版跑模型、写「AI 评分」，这个部署没有任何模型密钥，
 * 分数是两道闸门（预筛 + 两次独立打分）算出来的入选分，判断由人在 tooling/fixtures 里署名写过。
 * 叫「AI 评分」会让读者以为机器读了原文并作出判断——那是本站不该说的话（docs/known-issues.md）。
 */
export function ScoreLabel({ score, compact = false }: { score: number | null; compact?: boolean }) {
  // The score arrives from JSON nobody has validated. A non-finite value is not a score: render nothing,
  // the same answer as `null`, rather than a pill reading 「入选分 NaN」.
  if (score === null || typeof score !== "number" || !Number.isFinite(score)) return null;
  const value = Math.round(score);
  // …and an out-of-range one (a negative score from a bad write) still has to land somewhere: the last
  // tier is the quiet one. `TIERS.find(...)!` returned undefined for anything below its final `min: 0`
  // and the non-null assertion then threw on `.className`, which PageBoundary turned into
  // 「这一页没能显示出来」 for the whole feed.
  const tier = TIERS.find((t) => value >= t.min) ?? TIERS[TIERS.length - 1]!;
  return (
    <span
      role="img"
      title={`入选分 ${value}/100`}
      aria-label={`入选分 ${value} 分`}
      className={`inline-flex h-[20px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 ring-1 ring-inset ${tier.className}`}
    >
      {!compact && (
        <>
          <span className="text-label font-medium leading-none">入选分</span>
          <span className="h-2.5 w-px bg-current opacity-25" aria-hidden="true" />
        </>
      )}
      <span className="mono text-[12.5px] font-bold leading-none tabular-nums">{value}</span>
    </span>
  );
}
