// Server half of the discovery panel (see usage.server.ts for why the split exists).
import { adminGet } from "../../../lib/admin.server";
import type { DiscoveryData } from "./discovery";

export function loadDiscovery(request: Request) {
  return adminGet<DiscoveryData>(request, "/api/admin/discovery", 30_000);
}
