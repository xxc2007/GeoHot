import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { IconArrowUp, IconInfo } from "../icons";
import { buttonClass } from "../ui/Controls";
import { homeHref } from "./nav";

/** A thin accent line while a navigation is in flight (shown only if it takes a moment). */
export function NavigationProgress({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (active) timer.current = setTimeout(() => setVisible(true), 150);
    else {
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active]);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden" aria-hidden="true">
      <div
        className="h-full origin-left bg-accent"
        style={{
          transform: `scaleX(${visible ? 0.85 : active ? 0 : 1})`,
          opacity: visible ? 1 : 0,
          transition: visible ? "transform 2.4s cubic-bezier(0.1, 0.7, 0.2, 1), opacity 120ms" : "transform 200ms, opacity 300ms 120ms",
        }}
      />
    </div>
  );
}

/** Round "back to top" button once the reader has scrolled a screen or so. */
export function BackToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 1.2);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button
      type="button"
      aria-label="回到顶部"
      data-print="hide"
      tabIndex={shown ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
      // Hidden means hidden, not merely transparent: `opacity-0` alone left the button in the
      // accessibility tree, so a screen reader met a "回到顶部" that was nowhere on screen and inert to
      // the mouse, while `tabIndex={-1}` kept it out of the tab order (WCAG 2.4.3, 4.1.2). `invisible`
      // takes it out of both, and `visibility` is the one property that interpolates so the fade still
      // plays: visible immediately on show, hidden only at the end of the fade-out.
      className={`fixed bottom-[calc(70px+env(safe-area-inset-bottom))] right-4 z-30 flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-[var(--shadow-soft)] transition-all duration-200 hover:text-ink lg:bottom-6 lg:right-6 ${
        shown ? "translate-y-0 opacity-100" : "invisible pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <IconArrowUp size={18} />
    </button>
  );
}

/**
 * The page column's own error boundary.
 *
 * Until now the tree had exactly one boundary — `root.tsx`'s `ErrorBoundary` — so a card that threw
 * during render replaced the whole document, and because that boundary cannot tell "nobody matched
 * this path" from "this page broke", the reader got the 404 copy for a runtime failure with no way
 * back to the page they were on. This one sits inside `<main>`: the shell, the sidebar and the tab bar
 * survive, only the page column shows the failure, and retrying re-runs this page's loader.
 */
export class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; at: string | null }> {
  state: { error: Error | null; at: string | null } = { error: null, at: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; at: string | null }) {
    // Navigating somewhere else clears the old failure (the boundary must not strand a reader on a
    // page they have already left).
    return state.at !== props.resetKey ? { error: null, at: props.resetKey } : null;
  }
  render() {
    if (this.state.error) return <BoundaryFallback onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

/** What the page column shows when the page itself threw: an apology and a way out of it. */
function BoundaryFallback({ onRetry }: { onRetry: () => void }) {
  const revalidator = useRevalidator();
  const retrying = revalidator.state === "loading";
  return (
    <div role="alert" className="flex min-h-[45vh] flex-col items-center justify-center px-2 py-16 text-center">
      <IconInfo size={26} className="mb-3 text-ink-4" />
      <h1 className="text-[18px] font-bold text-ink">这一页没能显示出来</h1>
      <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-3">
        网站导航与其余内容照常工作。可以重试这一页，或者去精选看看。
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2.5">
        <button
          type="button"
          disabled={retrying}
          className={buttonClass("primary")}
          onClick={() => {
            onRetry();
            revalidator.revalidate();
          }}
        >
          {retrying ? "正在重试…" : "重试这一页"}
        </button>
        <a href={homeHref()} className={buttonClass("secondary")}>
          回到精选
        </a>
      </div>
    </div>
  );
}
