import type { Route } from "./+types/magpie";
import { adminGet } from "../../lib/admin.server";
import { publicPath } from "../../lib/public-path";
import { useEffect, useRef, useState } from "react";

export async function loader({ request }: Route.LoaderArgs) {
  await adminGet(request, "/api/admin/me", 5000);
  return null;
}
export default function Magpie() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    setState("loading");
    let ready = false;
    const recover = () => { if (attempt < 2) setAttempt(n => n + 1); else setState("failed"); };
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "geohot:magpie:ready") { ready = true; setState("ready"); }
      if (event.data?.type === "geohot:magpie:failed") { ready = true; setState("failed"); }
    };
    window.addEventListener("message", message);
    const timer = window.setTimeout(() => { if (!ready) recover(); }, 15_000);
    return () => { clearTimeout(timer); window.removeEventListener("message", message); };
  }, [attempt]);
  return <section className="flex h-[calc(100dvh-110px)] min-h-[560px] flex-col lg:h-dvh">
    <header className="border-b border-line px-5 py-4"><h1 className="text-xl font-semibold text-ink">magpie</h1><p className="mt-1 text-sm text-ink-3">服务器上的模型、供应商、路由和用量。</p></header>
    <div className="relative flex min-h-0 flex-1">
      <iframe ref={frame} key={attempt} title="服务器 Magpie" src={publicPath(`/api/admin/magpie-proxy/?embedAttempt=${attempt}`)} className="w-full min-h-0 flex-1 border-0 bg-surface" referrerPolicy="same-origin" />
      {state !== "ready" && <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface p-6 text-ink-3">
        <p>{state === "loading" ? "正在连接服务器 Magpie…" : "Magpie 暂时未连接，请重新连接。"}</p>
        {state === "failed" && <button className="rounded-lg bg-ink px-4 py-2 text-white" onClick={() => { setState("loading"); setAttempt(n => n + 1); }}>重新连接</button>}
      </div>}
    </div>
  </section>;
}
