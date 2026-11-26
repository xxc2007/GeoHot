import { redirect } from "react-router";
import type { Route } from "./+types/magpie";

// 2026-11-26：magpie 控制台并入运行看板（?tab=gateway），作为「模型网关」分页签内嵌。
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  q.set("tab", "gateway");
  throw redirect(`/admin/ops?${q}`, 302);
}

export default function GatewayMoved() {
  return null;
}
