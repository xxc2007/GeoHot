// Share poster sheet: the server-rendered poster (with a QR code to the article), to save or hand to the
// system share sheet. Loaded on demand from the article page; slides up on phones, centred on desktop.
import { useEffect, useRef, useState } from "react";
import { SITE } from "@aihot/industry/site";
import { Presence } from "../../components/ui/Presence";
import { IconClose, IconDownload, IconShare } from "../../components/icons";
import { publicPath } from "../../lib/public-path.ts";
import { focusWhenReady, returnFocus } from "../../lib/focus-when-ready.ts";

export default function PosterSheet({ id, title, open, onClose }: { id: string; title: string; open: boolean; onClose: () => void }) {
  // One address, three uses (<img src>, the download <a href>, the blob fetch behind 分享). It is
  // root-absolute, so it has to carry the deployment prefix — bare /og/… is not this app's path.
  const src = publicPath(`/og/posters/${id}.png`);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [canShareFile, setCanShareFile] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // The sheet claims to be a modal dialog, so it has to behave like one: the same three things
  // components/ui/Lightbox.tsx and features/item/TocSheet.tsx do (TocSheet's header records that this
  // exact bug — Tab walking out into the article behind the scrim, Escape dropping the reader on <body> —
  // was fixed here once already; the poster sheet never got it). Focus moves in on open, Tab and
  // Shift-Tab stay inside, Escape closes, and focus goes back to the button that opened it.
  useEffect(() => {
    if (!open) return;
    setShareFailed(false);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    // Presence mounts its children one commit after `open` flips, so the close button does not exist yet
    // in this effect's first pass — see lib/focus-when-ready.ts for what that looks like in a browser.
    const stopFocusRetry = focusWhenReady(() => closeButton.current);
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
    try {
      setCanShareFile(!!navigator.canShare?.({ files: [new File([], "p.png", { type: "image/png" })] }));
    } catch {
      setCanShareFile(false);
    }
    return () => {
      stopFocusRetry();
      document.removeEventListener("keydown", onKey);
      root.style.overflow = overflow;
      returnFocus(opener);
    };
  }, [open, onClose]);

  async function share() {
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.share({ files: [new File([blob], `${SITE.mcpPrefix}-${id}.png`, { type: "image/png" })], title });
      setShareFailed(false);
    } catch (e) {
      // 取图失败或系统分享面板拒绝，都要说出来；读者按「取消」关掉面板不算失败，保存那条路一直在。
      if ((e as DOMException)?.name !== "AbortError") setShareFailed(true);
    }
  }

  return (
    <Presence show={open} enter="anim-fade-in" exit="anim-fade-out" duration={220}>
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
        <button type="button" aria-label="关闭" className="absolute inset-0 bg-[rgba(8,14,15,0.55)] backdrop-blur-[3px]" onClick={onClose} />
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="分享海报"
          className="poster-sheet anim-sheet-in relative flex max-h-[92dvh] w-full flex-col items-center rounded-t-sheet bg-surface px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_40px_rgba(0,0,0,0.18)] sm:w-auto sm:rounded-sheet sm:px-7 sm:pb-6 sm:pt-5"
        >
          <span className="mb-3 h-1 w-10 rounded-full bg-line-strong sm:hidden" aria-hidden="true" />
          <div className="mb-3 flex w-full items-center justify-between">
            <span className="text-[14px] font-semibold text-ink">分享海报</span>
            <button ref={closeButton} type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink" aria-label="关闭">
              <IconClose size={16} />
            </button>
          </div>
          <div className="relative aspect-[3/4] w-full max-w-[min(360px,calc((92dvh-190px)*0.75))] overflow-hidden rounded-card border border-line bg-bg-sunk">
            {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.35)_50%,transparent_70%)] bg-[length:200%_100%]" />}
            {failed ? (
              <p className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-ink-3">海报生成失败，请稍后再试。</p>
            ) : (
              <img
                src={src}
                alt={`${title} · 分享海报`}
                className={`size-full object-contain transition-[opacity,transform] duration-[250ms] ${loaded ? "scale-100 opacity-100" : "scale-[0.985] opacity-0"}`}
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
              />
            )}
          </div>
          <p className="mt-3 text-[12.5px] text-ink-3">长按图片可保存或发送给朋友</p>
          <div className="mt-3 flex w-full max-w-[360px] gap-2">
            <a
              href={src}
              download={`${SITE.mcpPrefix}-${id}.png`}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent text-[13.5px] font-medium text-accent-contrast transition-colors hover:bg-accent-ink"
            >
              <IconDownload size={15} /> 保存图片
            </a>
            {canShareFile && (
              <button type="button" onClick={share} className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface text-[13.5px] font-medium text-ink transition-colors hover:border-ink-4">
                <IconShare size={15} /> 分享
              </button>
            )}
          </div>
          {shareFailed && <p role="status" className="mt-2 text-center text-[12.5px] text-ink-3">分享没有成功，可以先「保存图片」再发给朋友。</p>}
        </div>
      </div>
    </Presence>
  );
}
