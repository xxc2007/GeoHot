import type { ReactNode } from "react";

type Tone = "selected" | "accent" | "amber" | "hot" | "ok" | "neutral";

const TONES: Record<Tone, string> = {
  selected: "bg-amber-soft text-amber-ink",
  accent: "bg-accent-soft text-accent",
  amber: "bg-amber-soft text-amber-ink",
  // The `-ink` members of each pair are the text colours: `--hot` / `--ok` / `--amber` are fills, and on
  // their own soft wash they measure 4.05–4.38:1 (dark --hot on --hot-soft over --surface, light --ok on
  // --ok-soft), under AA for an 11px label. --hot-ink / --ok-ink are the same hue at 4.68:1 and 5.35:1.
  hot: "bg-hot-soft text-hot-ink",
  ok: "bg-ok-soft text-ok-ink",
  neutral: "bg-bg-sunk text-ink-3 border border-line-soft",
};

/** Small label next to a source or title: 精选, statuses and counts. */
export function Badge({ tone = "neutral", dot = false, children, className = "", title }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full px-2 text-label font-medium leading-none ${TONES[tone]} ${className}`}>
      {dot && <span className="size-[5px] rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** The "精选" mark on a report. */
export function SelectedBadge() {
  return (
    <Badge tone="selected" dot>
      精选
    </Badge>
  );
}
