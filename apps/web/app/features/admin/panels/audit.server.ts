// Server half of the audit panel (see usage.server.ts for why the split exists).
import { adminGet } from "../../../lib/admin.server";
import type { AuditRow } from "./audit";

export function loadAudit(request: Request) {
  const url = new URL(request.url);
  return adminGet<{ page: number; rows: AuditRow[]; hasMore: boolean }>(request, `/api/admin/audit${url.search}`);
}
