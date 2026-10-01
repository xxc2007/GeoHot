import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { IntentLink } from "./IntentLink";
import { useEntrance } from "../../lib/hydration";

/** Where each switch's thumb sat when it last left, relative to its track. */
const thumbs = new Map<string, { left: number; width: number; at: number }>();

/**
 * Keyboard for a single-choice radio group: one tab stop, arrows (and Home/End) move the choice and the
 * focus. Used by the switch's onSelect path and by the appearance control, so both behave the same way.
 * The caller picks by index because its own option list is in the same order as the rendered radios.
 */
export function radioKeyNav(e: KeyboardEvent<HTMLElement>, pick: (index: number) => void) {
  const from = e.currentTarget;
  const radios = Array.from(from.closest("[role=radiogroup]")?.querySelectorAll<HTMLElement>("[role=radio]") ?? []);
  const at = radios.indexOf(from);
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  const to = step ? (at + step + radios.length) % radios.length : e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : -1;
  if (at < 0 || to < 0 || to >= radios.length) return;
  e.preventDefault();
  pick(to);
  radios[to].focus();
}

function placeOf(el: HTMLElement) {
  const tab = el.parentElement!.getBoundingClientRect();
  const track = el.closest("[data-pill-track]")?.getBoundingClientRect();
  return { left: tab.left - (track?.left ?? 0), width: tab.width, at: Date.now() };
}

/**
 * The white thumb inside the chosen option. It is rendered in place (so it is right without
 * JavaScript) and, when the choice moves, glides over from where the previous thumb was.
 */
function Thumb({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const entrance = useEntrance();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = placeOf(el);
    const prev = thumbs.get(id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (entrance && !reduce && prev && now.at - prev.at < 1000 && (prev.left !== now.left || prev.width !== now.width) && el.animate) {
      el.animate(
        [{ transform: `translateX(${prev.left - now.left}px)`, width: `${prev.width}px` }, { transform: "translateX(0)", width: `${now.width}px` }],
        { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
      );
    }
    return () => {
      thumbs.set(id, placeOf(el));
    };
  }, [id, entrance]);
  return <span ref={ref} className="absolute inset-0 rounded-full bg-surface shadow-[var(--shadow-thumb)] ring-1 ring-line dark:bg-raised" />;
}

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Link target; tabs without one call onSelect. */
  to?: string;
  prefetch?: "intent";
  replace?: boolean;
  count?: number | null;
}

const SIZES = {
  md: "h-9 px-4 text-[14px]",
  sm: "h-8 px-3.5 text-[13px]",
  xs: "h-7 px-3 text-[12.5px]",
} as const;

/**
 * The site's one switch control: a grey pill track with a white thumb that glides to the chosen
 * option. Boards, categories, sources, report kinds, page sections and language all use it, so every
 * switch looks and moves the same. Scrolls sideways when it runs out of room; `fill` spreads the
 * options evenly across the available width.
 * Two modes, because the two kinds of switch are different things: options with `to` are links, so the
 * track is a `nav` and the chosen one carries `aria-current="page"`; options that call `onSelect` switch
 * state in place, so the track is a `radiogroup` and the chosen one is `aria-checked` — one tab stop,
 * arrows move the choice. (A `tablist` would need a `tabpanel` per option, and the panels belong to the
 * page that uses the control, not to it.)
 */
export function PillTabs({
  items, active, onSelect, layoutId, size = "md", label, fill = false, className = "",
}: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  /** Unique per control on a page, for the gliding thumb. */
  layoutId: string;
  size?: keyof typeof SIZES;
  label?: string;
  fill?: boolean;
  className?: string;
}) {
  const links = items.some((t) => t.to);
  const Track = links ? "nav" : "div";
  // Which option carries the group's single tab stop; falls back to the first so the group is always reachable.
  const activeAt = Math.max(0, items.findIndex((t) => t.key === active));
  return (
    <div className={`scrollbar-none max-w-full overflow-x-auto ${fill ? "w-full" : ""} ${className}`}>
      <Track
        data-pill-track=""
        aria-label={label}
        role={links ? undefined : "radiogroup"}
        className={`${fill ? "grid w-full" : "inline-flex w-max"} gap-0.5 rounded-full bg-bg-sunk p-[3px] ring-1 ring-inset ring-line-soft dark:bg-bg-muted/60`}
        style={fill ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined}
      >
        {items.map((t, i) => {
          const on = t.key === active;
          const inner = (
            <>
              {on && <Thumb id={layoutId} />}
              <span className="relative inline-flex items-center gap-1">
                {t.label}
                {t.count !== undefined && t.count !== null && <span className={`num text-[0.86em] font-normal ${on ? "text-ink-3" : "text-ink-4"}`}>{t.count}</span>}
              </span>
            </>
          );
          const cls = `relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium outline-offset-1 transition-colors duration-150 active:scale-[0.98] ${SIZES[size]} ${on ? "text-ink" : "text-ink-3 hover:text-ink"}`;
          const TabLink = t.prefetch === "intent" ? IntentLink : Link;
          return t.to ? (
            <TabLink key={t.key} to={t.to} replace={t.replace} preventScrollReset aria-current={on ? "page" : undefined} className={cls}>
              {inner}
            </TabLink>
          ) : (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === activeAt ? 0 : -1}
              onKeyDown={(e) => radioKeyNav(e, (to) => onSelect?.(items[to].key))}
              onClick={() => onSelect?.(t.key)}
              className={cls}
            >
              {inner}
            </button>
          );
        })}
      </Track>
    </div>
  );
}
