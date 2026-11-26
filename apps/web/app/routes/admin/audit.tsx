import { redirect } from "react-router";
import type { Route } from "./+types/audit";

// 2026-11-26：审计记录并入运行看板（?tab=audit）。
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  q.set("tab", "audit");
  throw redirect(`/admin/ops?${q}`, 302);
}

export default function AuditMoved() {
  return null;
}
