import { sql, type Tx } from "../db.ts";
import { CapacityExceeded, CapacityGate } from "../lib/capacity.ts";

export class PublicReadBusyError extends Error {
  readonly retryAfter = 2;
}

// Heavy, cold public aggregate reads share two slots. No waiting queue can grow under
// arbitrary filter combinations; workers and inexpensive detail reads keep their pool slots.
const aggregates = new CapacityGate(2, 0);
export async function withPublicRead<T>(read: (db: Tx) => Promise<T>, timeoutMs = 8000, customPlan = false): Promise<T> {
  try {
    return await aggregates.run(() => sql.begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      // The anchor partial index needs actual filter values while sharing this same bounded transaction.
      if (customPlan) await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
      return read(tx);
    }) as Promise<T>);
  } catch (error) {
    if (error instanceof CapacityExceeded || (error as { code?: string }).code === "57014") {
      throw new PublicReadBusyError("Public aggregate reads are temporarily busy");
    }
    throw error;
  }
}
