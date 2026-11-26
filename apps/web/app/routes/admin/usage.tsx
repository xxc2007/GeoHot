import { redirect } from "react-router";
import type { Route } from "./+types/usage";

// 2026-11-26：用量总览并入运行看板（?tab=usage）。旧地址保留重定向，书签和旧截图里的链接不失效。
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  q.set("tab", "usage");
  throw redirect(`/admin/ops?${q}`, 302);
}

export default function UsageMoved() {
  return null;
}
