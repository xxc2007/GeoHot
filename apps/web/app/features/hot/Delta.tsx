import type { HotEntryView } from "@aihot/contracts/site";
import { useLocale } from "../../lib/i18n";
import { copy } from "../../lib/i18n/pages/hot";

/** Change against six hours before the ranking: up in the hot tone, down quiet, new stories marked new, none while sources are behind. */
export function Delta({ trend, pct, className = "" }: { trend: HotEntryView["trend"]; pct: number | null; className?: string }) {
  const c = copy[useLocale()].delta;
  const base = `inline-flex h-[22px] shrink-0 items-center gap-0.5 rounded-full px-2 text-[11.5px] font-medium tabular-nums ${className}`;
  if (trend === "unknown") return <span className={`${base} bg-bg-sunk text-ink-4 dark:bg-bg-muted/60`} title={c.unknownTitle}>{c.unknown}</span>;
  if (trend === "new" || pct === null) return <span className={`${base} bg-accent-soft text-accent`}>{c.newLabel}</span>;
  if (trend === "flat") return <span className={`${base} bg-bg-sunk text-ink-4 dark:bg-bg-muted/60`} title={c.flatTitle}>{c.flat}</span>;
  const up = trend === "up";
  return (
    <span className={`${base} ${up ? "bg-hot-soft text-hot-ink" : "bg-bg-sunk text-ink-4 dark:bg-bg-muted/60"}`} title={up ? c.upTitle : c.downTitle}>
      {up ? "↑" : "↓"} {Math.abs(Math.round(pct))}%
    </span>
  );
}