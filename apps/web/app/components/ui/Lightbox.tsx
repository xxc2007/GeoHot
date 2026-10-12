import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Presence } from "./Presence";
import { IconArrowLeft, IconArrowRight, IconClose } from "../icons.tsx";
import { focusWhenReady, returnFocus } from "../../lib/focus-when-ready.ts";

export interface LightboxImage {
  src: string;
  alt?: string | null;
}

/** While a two-finger page zoom is live the browser owns the gesture: no drag, paging or swipe-close. */
const pinchZoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;

/** How a drag that goes nowhere settles back; the overlay tint follows the same curve. */
const SETTLE_MS = 220;
const SETTLE = `${SETTLE_MS}ms cubic-bezier(0.22,1,0.36,1)`;

/**
 * Pictures shown full size over the page. While open, keyboard focus stays in the viewer (Tab moves
 * between its buttons), the page behind does not scroll, Escape closes it and the arrow keys move
 * between pictures; closing puts focus back where it was. One touch finger drags: sideways pages
 * (with several pictures), downwards closes, anything shorter springs back — a pinch zoom, though,
 * is left to the browser, and while the page is zoomed in the drag gestures stand down.
 */
export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const open = index !== null && !!images[index];
  const dialog = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const state = useRef({ index, count: images.length, onIndex, onClose });
  state.current = { index, count: images.length, onIndex, onClose };
  // The finger drives inline styles directly: state would re-render the portal on every touchmove.
  // `axis` locks past 8px and never flips, so one diagonal swipe commits to a single direction.
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; axis: null | "x" | "y" } | null>(null);
  // Set after a real drag so the click that trails touchend cannot read as a tap on the backdrop.
  const suppressTap = useRef(false);

  const step = (by: number) => {
    const { index: at, count, onIndex: go } = state.current;
    if (at !== null && count > 1) go((at + by + count) % count);
  };

  /** End a drag: `spring` eases the last pose back into place, otherwise inline styles drop at once. */
  const settle = (spring: boolean) => {
    const img = picture.current;
    const overlay = dialog.current;
    if (img && spring) {
      img.style.transition = `transform ${SETTLE}`;
      img.style.transform = "translate(0, 0)";
    } else if (img) {
      img.style.transition = "";
      img.style.transform = "";
    }
    if (overlay && spring) {
      overlay.style.transition = `background-color ${SETTLE}`;
      overlay.style.backgroundColor = "rgba(0,0,0,0.85)";
    } else if (overlay) {
      overlay.style.transition = "";
      overlay.style.backgroundColor = "";
    }
    if (spring) {
      setTimeout(() => {
        if (drag.current) return; // a new drag started before the spring finished; it owns the styles now
        if (picture.current) { picture.current.style.transition = ""; picture.current.style.transform = ""; }
        if (dialog.current) { dialog.current.style.transition = ""; dialog.current.style.backgroundColor = ""; }
      }, SETTLE_MS + 20);
    }
  };

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    const stopFocusRetry = focusWhenReady(() => closeButton.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") state.current.onClose();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "Tab") {
        const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        if (!focusable.length) return;
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at === focusable.length - 1 ? 0 : at + 1;
        focusable[next]!.focus();
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      stopFocusRetry();
      document.removeEventListener("keydown", onKey);
      root.style.overflow = overflow;
      returnFocus(opener);
    };
  }, [open]);

  const current = open ? images[index!]! : null;
  const many = images.length > 1;
  const onTouchStart = (e: React.TouchEvent) => {
    suppressTap.current = false; // a fresh touch re-arms tap-to-close if the last release fired no click
    if (state.current.index === null || e.touches.length !== 1 || pinchZoomed()) return;
    if (e.target instanceof Element && e.target.closest("button")) return; // buttons tap, they do not drag
    const t = e.touches[0];
    drag.current = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, axis: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (!d) return;
    if (e.touches.length > 1 || pinchZoomed()) {
      drag.current = null; // a pinch took over mid-drag: hand the pose back and stand down
      settle(true);
      return;
    }
    const t = e.touches[0];
    d.dx = t.clientX - d.x;
    d.dy = t.clientY - d.y;
    if (d.axis === null && Math.hypot(d.dx, d.dy) > 8) d.axis = Math.abs(d.dx) > Math.abs(d.dy) ? "x" : "y";
    const img = picture.current;
    if (!img || d.axis === null) return;
    img.style.transition = "none";
    if (d.axis === "x") {
      if (many) img.style.transform = `translate(${d.dx}px, 0)`;
    } else {
      const dy = Math.max(0, d.dy); // only downwards; the tint follows the same clamp
      img.style.transform = `translate(0, ${dy}px)`;
      if (dialog.current) dialog.current.style.backgroundColor = `rgba(0,0,0,${Math.max(0.3, 0.85 - dy / 600)})`;
    }
  };
  const onTouchEnd = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.axis !== null) suppressTap.current = true;
    if (d.axis === "x" && many && Math.abs(d.dx) > 60) {
      settle(false); // snap flat before the swap so the next picture enters from the resting pose
      step(d.dx < 0 ? 1 : -1);
    } else if (d.axis === "y" && d.dy > 110) {
      settle(false);
      state.current.onClose();
    } else if (d.axis !== null) {
      settle(true);
    }
  };
  const onTouchCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    settle(true);
  };

  const nav = "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20";
  if (typeof document === "undefined") return null;
  return createPortal(
    <Presence show={open} enter="anim-fade-in" exit="anim-fade-out" duration={160}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={many && index !== null ? `图片 ${index + 1} / ${images.length}` : "图片"}
        onClick={() => {
          if (suppressTap.current) { suppressTap.current = false; return; }
          onClose();
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        className="fixed inset-0 z-[80] grid cursor-zoom-out touch-pinch-zoom place-items-center bg-black/85 p-4 sm:p-10"
      >
        {current && (
          <img key={current.src} ref={picture} src={current.src} decoding="async" alt={current.alt ?? ""} className="lightbox-img anim-zoom-in min-h-0 min-w-0 max-h-[calc(100dvh-5rem)] max-w-full rounded-control object-contain shadow-2xl" />
        )}
        <button ref={closeButton} type="button" aria-label="关闭" onClick={(e) => { e.stopPropagation(); onClose(); }} className="absolute right-[max(16px,env(safe-area-inset-right))] top-[max(16px,env(safe-area-inset-top))] grid size-11 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20">
          <IconClose size={18} />
        </button>
        {many && index !== null && (
          <>
            <button type="button" aria-label="上一张" onClick={(e) => { e.stopPropagation(); onIndex((index - 1 + images.length) % images.length); }} className={`${nav} left-[max(12px,env(safe-area-inset-left))] sm:left-5`}>
              <IconArrowLeft size={18} />
            </button>
            <button type="button" aria-label="下一张" onClick={(e) => { e.stopPropagation(); onIndex((index + 1) % images.length); }} className={`${nav} right-[max(12px,env(safe-area-inset-right))] sm:right-5`}>
              <IconArrowRight size={18} />
            </button>
            <span className="num pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2.5 py-0.5 text-[12px] text-white/85">
              {index + 1} / {images.length}
            </span>
          </>
        )}
      </div>
    </Presence>, document.body
  );
}
