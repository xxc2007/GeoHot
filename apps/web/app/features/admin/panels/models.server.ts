// Server half of the models panel (see usage.server.ts for why the split exists).
import { adminGet } from "../../../lib/admin.server";
import type { Models } from "./models";

export function loadModels(request: Request) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  return adminGet<Models>(request, `/api/admin/models?days=${encodeURIComponent(days)}`);
}
