import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HotParticipant } from "@aihot/contracts/site";
import { shortSourceName } from "../../lib/format";
import { SourceAvatar } from "../../components/ui/SourceAvatar";

/**
 * Who is talking about a hot story: overlapping faces of the 精选组 sources in the order the server
 * gives (T1, T1.5, T2), then a count for everyone else, 氛围组 included. Hover lists every name; where
 * the faces are their own control (not inside a link), a tap or Enter opens the list, as the legacy
 * list's <details> did, so phones and keyboards reach it too.
 */
export function Faces({ participants, total, size = 24, max = 6, interactive = true }: { participants: HotParticipant[]; total: number; size?: number; max?: number; interactive?: boolean }) {
  const shown = participants.filter((p) => p.kind === "editorial").slice(0, max);
  const rest = total - shown.length;
  const names = participants.map((p) => shortSourceName(p.name)).join("、");
  const faces = (
    <>
      {shown.map((p, i) => (
        // 4px of overlap, not 6: at 20-22px a favicon is already only a few glyphs wide, and the tighter
        // stack made two logos read as one smudged mark (measured in the 2026-10-03 screenshots).
        <span key={p.name} className={`rounded-full ring-2 ring-surface ${i ? "-ml-1" : ""}`}>
          <SourceAvatar name={p.name} iconUrl={p.iconUrl} iconSrcSet={p.iconSrcSet} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span className="-ml-1 inline-flex items-center justify-center rounded-full bg-bg-sunk px-1.5 text-[10.5px] font-medium text-ink-3 ring-2 ring-surface dark:bg-bg-muted" style={{ height: size, minWidth: size }}>
          +{rest}
        </span>
      )}
    </>
  );
  if (!interactive) {
    return (
      <span className="relative z-10 flex shrink-0 items-center" title={names}>
        {faces}
      </span>
    );
  }
  return <FacesButton participants={participants} total={total} names={names}>{faces}</FacesButton>;
}

function FacesButton({ participants, total, names, children }: { participants: HotParticipant[]; total: number; names: string; children: React.ReactNode }) {
  // Where the list opens: under the faces, kept on screen; fixed, so a card's clipping never hides it.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const root = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const id = useId();
  // The popup is a non-modal dialog, so it needs the two things that make that honest: focus moves into
  // it when it opens (a screen reader otherwise announces only `aria-expanded` and the names never get
  // read), and focus comes back to the faces when it closes (otherwise Escape drops the reader on
  // <body>, several tab stops away from where they were).
  // The restore belongs in `close`, not in an effect watching `open`: unmounting the portal clears the
  // popup ref before that effect runs, so by then there is nothing left to ask "was focus inside it?".
  // Measured in a real browser — the effect version lost focus to <body> on every Escape.
  const wasOpen = useRef(false);
  const close = () => {
    if (popup.current?.contains(document.activeElement)) root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    setAt(null);
  };
  useEffect(() => {
    if (open && !wasOpen.current) popup.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const editorial = participants.filter((p) => p.kind === "editorial");
  const signal = participants.filter((p) => p.kind !== "editorial");
  const more = total - participants.length;
  return (
    <span ref={root} className="relative z-10 inline-flex shrink-0">
      <button
        type="button"
        title={names}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${total} 位参与者，查看名单`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) return close();
          const r = e.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - r.bottom > 240;
          setAt({ top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - 240), left: Math.min(Math.max(8, r.left), document.documentElement.clientWidth - 248) });
        }}
        className="-m-1 flex items-center rounded-full p-1 outline-offset-2"
      >
        {children}
      </button>
      {open && createPortal(
        // tabIndex makes it focusable (the dialog above) and reachable by Tab while it scrolls (WCAG 2.1.1:
        // a scrollable region must be keyboard operable, and a name list can overflow on a short screen).
        <span
          ref={popup} id={id} role="dialog" aria-label="参与讨论的来源" tabIndex={-1} style={at}
          onKeyDown={(e) => {
            if (e.key === "Tab") { e.preventDefault(); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
          }}
          className="fixed z-50 max-h-[240px] w-[240px] overflow-y-auto rounded-control border border-line bg-raised p-3 text-[12.5px] leading-relaxed text-ink-2 shadow-[var(--shadow-pop)] outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {editorial.length > 0 && (
            <>
              <span className="block text-[11.5px] font-semibold text-ink-4">精选组</span>
              <span className="mt-0.5 block">{editorial.map((p) => shortSourceName(p.name)).join("、")}</span>
            </>
          )}
          {signal.length > 0 && (
            <>
              <span className={`block text-[11.5px] font-semibold text-ink-4 ${editorial.length ? "mt-2" : ""}`}>氛围组</span>
              <span className="mt-0.5 block">{signal.map((p) => shortSourceName(p.name)).join("、")}</span>
            </>
          )}
          {more > 0 && <span className="mt-2 block text-[11.5px] text-ink-4">另有 {more} 位未列出</span>}
        </span>, document.body
      )}
    </span>
  );
}
