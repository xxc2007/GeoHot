import { redirect } from "react-router";
import type { Route } from "./+types/discovery";

// 2026-11-26：信源发现并入信源页（?tab=discover）。
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  q.set("tab", "discover");
  throw redirect(`/admin/sources?${q}`, 302);
}

export default function DiscoveryMoved() {
  return null;
}
