import type { Route } from "./+types/magpie";
import { adminGet } from "../../lib/admin.server";
import { publicPath } from "../../lib/public-path";
import { useEffect, useRef, useState } from "react";

export async function loader({ request }: Route.LoaderArgs) {
  await adminGet(request, "/api/admin/me", 5000);
  return null;
}

type MagpieState =
  | { phase: "loading"; attempt: number; since: number }
  | { phase: "ready" }
  | { phase: "error"; reason: string; attempt: number; at: number };

// Bounded connection budget. The injected readiness script posts `geohot:magpie:ready` once
// the upstream page actually renders #pageTitle, and `geohot:magpie:failed` on a script error.
// If neither arrives within CONNECT_TIMEOUT we stop the spinner and surface a real error with
// a retry — the page must never hang on "正在连接服务器".
const CONNECT_TIMEOUT = 20_000;

export default function Magpie() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<MagpieState>({ phase: "loading", attempt: 0, since: Date.now() });

  useEffect(() => {
    setState({ phase: "loading", attempt, since: Date.now() });
    setDismissed(false);
    let settled = false;
    const finish = (s: MagpieState) => { if (!settled) { settled = true; setState(s); } };

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
    <section className="flex h-[calc(100dvh-110px)] min-h-[560px] flex-col lg:h-dvh">
      <header className="border-b border-line px-5 py-4">
        <h1 className="text-xl font-semibold text-ink">magpie</h1>
        <p className="mt-1 text-sm text-ink-3">服务器上的模型、供应商、路由和用量。</p>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <iframe
          ref={frame}
          key={attempt}
          title="服务器 Magpie"
          src={publicPath(`/api/admin/magpie-proxy/?embedAttempt=${attempt}`)}
          className="w-full min-h-0 flex-1 border-0 bg-surface"
          referrerPolicy="same-origin"
        />
        {state.phase !== "ready" && !dismissed && (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface p-6 text-center text-ink-3"
          >
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
    </section>
  );
}
