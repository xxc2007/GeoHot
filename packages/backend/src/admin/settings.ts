// Operator settings: per-service request budgets (the circuit breaker paid calls check before
// sending). The notification-target admin surface was retired on 2026-10-31 with the QR codes
// before it: the operator runs no Feishu, both seeded targets had never been enabled and the
// content-push valve is off, so the settings card, the toggle endpoint and their queries went —
// the dormant delivery chain (deliver.ts, valve-gated) is untouched.
import { sql } from "../db.ts";
import { InvalidInput } from "./invalid.ts";
import { audit } from "./auth.ts";
import { unbilledAttempt } from "../providers/receipts.ts";

export async function listBudgets() {
  // 与熔断器同一口径：明确未计费才排除；未知费用和发送前预留都占额度，usage 缺失不代表免费。
  const unbilled = unbilledAttempt();
  return sql`
    SELECT b.service, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day' AND NOT ${unbilled}) AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour' AND NOT ${unbilled}) AS used_hour
    FROM budgets b ORDER BY b.service`;
}

export async function updateBudget(service: string, input: { perMinute: number; perHour: number; perDay: number; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new InvalidInput("reason is required");
  for (const v of [input.perMinute, input.perHour, input.perDay]) if (!Number.isInteger(v) || v < 0) throw new InvalidInput("budgets are non-negative integers (0 stops the service)");
  const [before] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  const [after] = await sql`
    INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES (${service}, ${input.perMinute}, ${input.perHour}, ${input.perDay}, ${input.reason})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note, updated_at = now()
    RETURNING service, per_minute, per_hour, per_day`;
  await audit(actor, "budget.update", `budget:${service}`, input.reason, before ?? null, after);
  return after;
}

/**
 * Retire a service's budget row outright (not just zero it): the row is gone from the breaker table
 * and the admin list, while receipts / receipt_attempts / metrics stay untouched — they are the bill
 * and the audit trail for the spend that already happened. With no row, checkBudget's "missing"
 * branch keeps any accidental call to a retired service from going out (receipts.ts:104-105).
 */
export async function deleteBudget(service: string, reason: string, actor: string): Promise<{ service: string; per_minute: number; per_hour: number; per_day: number } | null> {
  if (!reason?.trim()) throw new InvalidInput("reason is required");
  const [before] = await sql<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  if (!before) return null;
  await sql`DELETE FROM budgets WHERE service = ${service}`;
  await audit(actor, "budget.delete", `budget:${service}`, reason, before, null);
  return before;
}
