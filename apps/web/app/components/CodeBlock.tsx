import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "./icons";

export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  // The "已复制" reset is a timer, and a timer an unmount never cancels fires `setCopied` on a component
  // that is gone (React 19 drops it, but it also meant a navigation inside 1.5s kept a hidden page alive
  // in the closure). One pending timer per button, cleared on the next copy and on unmount.
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (reset.current) clearTimeout(reset.current); }, []);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        if (reset.current) clearTimeout(reset.current);
        setCopied(true);
        reset.current = setTimeout(() => setCopied(false), 1500);
      }}
      className={`inline-flex h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-[12px] transition-colors ${copied ? "text-ok" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={copied ? "已复制" : label}
    >
      <span key={copied ? "ok" : "copy"} className={copied ? "anim-swap-in" : ""}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </span>
      {copied ? "已复制" : label}
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
