import { redirect } from "react-router";
import type { Route } from "./+types/models";

// 2026-11-26：模型页并入运行看板（?tab=models）。
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  q.set("tab", "models");
  throw redirect(`/admin/ops?${q}`, 302);
}

export default function ModelsMoved() {
  return null;
}
