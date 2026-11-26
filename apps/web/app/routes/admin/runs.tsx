import { redirect } from "react-router";
import type { Route } from "./+types/runs";

// 2026-11-26: the queue / schedule / receipt sections moved into 运行看板 (/admin/ops) so the model layer
// and the workload it runs on are read on one page. This route stays as a redirect for bookmarks and for
// links inside older notes; deleting it outright would 404 them.
export async function loader(_args: Route.LoaderArgs) {
  throw redirect("/admin/ops", 302);
}

export default function RunsMoved() {
  return null;
}
