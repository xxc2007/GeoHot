// 本文目录抽屉。小节清单（`outline`）本来只挂在 ArticleLayout 的两道 aside 里，而那两道都是
// `hidden … lg:block`（components/ui/Page.tsx:38,41）——手机与平板整棵目录树够不着。条目页工具栏里的
// 「目录」把这同一份清单从屏幕底部拉起来，点一条跳到正文里对应的小节。
//
// 焦点与背景滚动的处理照 components/ui/Lightbox.tsx：打开时焦点进抽屉、Tab 只在抽屉里走、Escape 关闭，
// 关闭时焦点还给触发它的那个按钮（本站上一轮刚因为「Escape 之后焦点掉在 body 上」改过一次，别再来一次）。
// 三条退路：Escape、遮罩、右上角关闭按钮，都走同一个 onClose。
//
// 动画只有类名，没有时长表：进场 `.anim-sheet-in`、退场随遮罩 `.anim-fade-out`，`prefers-reduced-motion`
// 由 app.css:387 的全局规则统一接管，这里不再判第二次。唯一要脚本决定的是 scrollIntoView 的 behavior，
// 而那次 `matchMedia` 读在点击之后，不读在渲染里——SSR 与水合后的第一帧因此是同一份 HTML。
import { useEffect, useRef } from "react";
import type { OutlineEntry } from "@aihot/contracts/site";
import { Presence } from "../../components/ui/Presence";
import { IconClose } from "../../components/icons";

/** 遮罩退场的时长，和 app.css 里 `.anim-fade-out` 的默认 `--anim-ms` 对齐。 */
const CLOSE_MS = 220;

export default function TocSheet({ outline, open, onClose }: { outline: OutlineEntry[]; open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  /** 读者选中的那一节：关抽屉后要跳到它，而不是回到打开前的位置。 */
  const picked = useRef<string | null>(null);
  /** 那次延后跳转的定时器：卸载要把它收掉，见下面的 cleanup。 */
  const jump = useRef<number | null>(null);

  // 解锁与跳转之间隔一帧，滚动才真的发生；但这一帧是借来的：读者可能已经走到另一页。
  // markdown 的小节 id 每页都叫 s1…sN（lib/markdown.ts:24），所以 220ms 之内导航过去，
  // getElementById 会在别人家的页面上找到同号的小节，把 URL 写成一个不属于这页的 #sN，还顺手滚一段。
  // 卸载时（这一条 effect 的主 cleanup 之后跑）把定时器清掉，再按打开时记下的地址校验一次。
  useEffect(
    () => () => {
      if (jump.current !== null) clearTimeout(jump.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    picked.current = null;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const top = window.scrollY;
    // 这一页的地址（含查询串）：延后跳转前用它确认读者还在这页。
    const here = window.location.pathname + window.location.search;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("a[href], button") ?? [])];
      if (!focusable.length) return;
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at === focusable.length - 1 ? 0 : at + 1;
      focusable[next]!.focus();
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      root.style.overflow = overflow;
      opener?.focus({ preventScroll: true });
      const id = picked.current;
      if (!id) {
        // 有些浏览器（iOS Safari）锁住背景滚动时把页面弹回顶部；关抽屉后送回读者原来在读的那一段。
        if (Math.abs(window.scrollY - top) > 1) window.scrollTo({ top, behavior: "auto" });
        return;
      }
      jump.current = window.setTimeout(() => {
        jump.current = null;
        if (window.location.pathname + window.location.search !== here) return;
        const el = document.getElementById(id);
        if (!el) return;
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
        history.replaceState(history.state, "", `#${id}`);
      }, CLOSE_MS);
    };
  }, [open, onClose]);

  return (
    <Presence show={open} enter="anim-fade-in" exit="anim-fade-out" duration={CLOSE_MS}>
      <div className="fixed inset-0 z-50 flex items-end justify-center">
        <button type="button" aria-label="关闭" className="absolute inset-0 bg-[rgba(8,14,15,0.5)] backdrop-blur-[2px]" onClick={onClose} />
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="本文目录"
          className="anim-sheet-in relative flex max-h-[78dvh] w-full flex-col rounded-t-sheet bg-surface shadow-[0_-12px_40px_rgba(0,0,0,0.18)]"
        >
          <span className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
          <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-1">
            <span className="text-[14px] font-semibold text-ink">本文目录</span>
            <button
              ref={closeButton}
              type="button"
              aria-label="关闭目录"
              onClick={onClose}
              className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink"
            >
              <IconClose size={16} />
            </button>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {outline.map((o) => (
              <li key={o.id}>
                <a
                  href={`#${o.id}`}
                  onClick={(e) => {
                    // 背景还锁着滚动，原生跳转会落空：先记下这一节，关掉抽屉、解锁之后再滚。
                    e.preventDefault();
                    picked.current = o.id;
                    onClose();
                  }}
                  className={`block border-l border-transparent py-2 pr-3 text-[14px] leading-snug text-ink-2 transition-colors hover:border-accent hover:bg-bg-sunk hover:text-ink ${o.level > 2 ? "ml-5 pl-3" : "ml-px pl-4"}`}
                >
                  {o.text}
                </a>
              </li>
            ))}
          </ol>
          <p className="shrink-0 border-t border-line-soft px-5 py-2.5 text-[12px] text-ink-4">共 {outline.length} 节 · 点一条跳到正文对应位置</p>
        </div>
      </div>
    </Presence>
  );
}
