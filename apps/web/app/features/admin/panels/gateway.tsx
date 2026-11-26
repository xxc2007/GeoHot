// 模型网关面板（原 /admin/magpie 页）：服务器上的 magpie 控制台，用同源代理嵌进运行看板的
// 「模型网关」分页签。整页 iframe 的逻辑原样保留：就绪信号 + 20 秒连接预算 + 显式失败与重连，
// 页面永远不会停在「正在连接服务器」。
import { publicPath } from "../../../lib/public-path";
import { useEffect, useRef, useState } from "react";

type GatewayState =
  | { phase: "loading"; attempt: number; since: number }
  | { phase: "ready" }
  | { phase: "error"; reason: string; attempt: number; at: number };

// Bounded connection budget. The injected readiness script posts `geohot:magpie:ready` once
// the upstream page actually renders #pageTitle, and `geohot:magpie:failed` on a script error.
// If neither arrives within CONNECT_TIMEOUT we stop the spinner and surface a real error with
// a retry — the page must never hang on "正在连接服务器".
const CONNECT_TIMEOUT = 20_000;

export function GatewayPanel() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<GatewayState>({ phase: "loading", attempt: 0, since: Date.now() });

  useEffect(() => {
    setState({ phase: "loading", attempt, since: Date.now() });
    setDismissed(false);
    let settled = false;
    const finish = (s: GatewayState) => { if (!settled) { settled = true; setState(s); } };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "geohot:magpie:ready") finish({ phase: "ready" });
      else if (event.data?.type === "geohot:magpie:failed")
        finish({ phase: "error", reason: "Magpie 页面脚本加载失败", attempt, at: Date.now() });
    };
    const onIframeError = () =>
      finish({ phase: "error", reason: "Magpie 页面资源加载失败", attempt, at: Date.now() });

    window.addEventListener("message", onMessage);
    const el = frame.current;
    el?.addEventListener("error", onIframeError);
    const timer = window.setTimeout(
      () => finish({ phase: "error", reason: "连接服务器 Magpie 超时（20 秒无响应）", attempt, at: Date.now() }),
      CONNECT_TIMEOUT,
    );
    return () => {
      window.removeEventListener("message", onMessage);
      el?.removeEventListener("error", onIframeError);
      window.clearTimeout(timer);
    };
  }, [attempt]);

  const reconnect = () => { setDismissed(false); setAttempt((n) => n + 1); };

  return (
    <div className="relative flex h-[calc(100dvh-15rem)] min-h-[520px] flex-col overflow-hidden rounded-panel bg-surface ring-1 ring-line">
      <iframe
        ref={frame}
        key={attempt}
        title="服务器 Magpie"
        src={publicPath(`/api/admin/magpie-proxy/?embedAttempt=${attempt}`)}
        className="w-full min-h-0 flex-1 border-0 bg-surface"
        referrerPolicy="same-origin"
      />
      {state.phase !== "ready" && !dismissed && (
        <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface p-6 text-center text-ink-3">
          {state.phase === "loading" ? (
            <>
              <div className="size-8 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden="true" />
              <p>正在连接服务器 Magpie…</p>
              <p className="text-xs text-ink-4">已等待 {Math.round((Date.now() - state.since) / 1000)} 秒</p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink">{state.reason}</p>
              <p className="text-xs text-ink-4">本次连接在 {new Date(state.at).toLocaleTimeString("zh-CN", { hour12: false })} 失败。</p>
              <div className="flex gap-2">
                <button className="rounded-lg bg-ink px-4 py-2 text-white" onClick={reconnect}>重新连接</button>
                <button className="rounded-lg border border-line px-4 py-2 text-ink-2" onClick={() => setDismissed(true)}>
                  忽略并查看
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
