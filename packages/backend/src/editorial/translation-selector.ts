import { sql, type Tx } from "../db.ts";

/** Bound selector SQL on the server; release the read transaction before any model request. */
export async function translationSelectorRead<T>(read: (tx: Tx) => Promise<T>, timeoutMs = 2000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw new Error("Invalid translation selector timeout");
  return sql.begin(async tx => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SELECT set_config('statement_timeout',${`${timeoutMs}ms`},true),set_config('lock_timeout','250ms',true)`;
    return read(tx);
  }) as Promise<T>;
}
