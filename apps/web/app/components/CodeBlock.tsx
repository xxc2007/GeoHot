import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  // The "已复制" reset is a timer, and a timer an unmount never cancels fires `setStatus` on a component
  // that is gone (React 19 drops it, but it also meant a navigation inside 1.5s kept a hidden page alive
  // in the closure). One pending timer per button, cleared on the next copy and on unmount.
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current) clearTimeout(reset.current); }, []);
  return (
    <button
      type="button"
      onClick={async () => {
        // 剪贴板 API 走不通就退到 execCommand；两条路都没走通时不能说「已复制」。
        let ok = true;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          ta.remove();
        }
        if (reset.current) clearTimeout(reset.current);
        setStatus(ok ? "copied" : "failed");
        if (ok) reset.current = setTimeout(() => setStatus("idle"), 1500);
      }}
      className={`inline-flex h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-[12px] transition-colors ${status === "copied" ? "text-ok" : status === "failed" ? "text-ink-2" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={status === "copied" ? "已复制" : status === "failed" ? "复制失败" : label}
    >
      <span key={status} className={status === "copied" ? "anim-swap-in" : ""}>
        {status === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
      {status === "copied" ? "已复制" : status === "failed" ? "复制失败" : label}
    </button>
  );
}

/** Code panel on the page's quiet grey, with a copy button; `lang` is only a label. */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[12px] text-ink-4">{title ?? lang ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className="mono overflow-x-auto bg-bg-sunk/60 px-4 py-4 text-[12.5px] leading-[1.75] text-ink-2 dark:bg-bg-muted/40">
        <code>{code}</code>
      </pre>
    </div>
  );
}
