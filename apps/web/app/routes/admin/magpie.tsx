import type { Route } from "./+types/magpie";
import { adminGet } from "../../lib/admin.server";
import { publicPath } from "../../lib/public-path";

export async function loader({ request }: Route.LoaderArgs) {
  await adminGet(request, "/api/admin/me", 5000);
  return null;
}
export default function Magpie() {
  return <section className="flex h-[calc(100dvh-110px)] min-h-[560px] flex-col lg:h-dvh">
    <header className="border-b border-line px-5 py-4"><h1 className="text-xl font-semibold text-ink">magpie</h1><p className="mt-1 text-sm text-ink-3">服务器上的模型、供应商、路由和用量。</p></header>
    <iframe title="服务器 Magpie" src={publicPath("/api/admin/magpie-proxy/")} className="w-full min-h-0 flex-1 border-0 bg-surface" referrerPolicy="same-origin" />
  </section>;
}
