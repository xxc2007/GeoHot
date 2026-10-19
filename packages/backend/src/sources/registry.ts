import { sql, type Db, type Tx } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { sha256, stableJson } from "../lib/ids.ts";

export class SourceRegistryConflict extends Error { code = "source_registry_conflict"; status = 409; }
export class SourceCapacityExceeded extends SourceRegistryConflict { override code = "source_capacity_exceeded"; }
export interface RegistryPolicy { target_enabled: number | null; enabled_count: number; policy_version: number }

export async function lockRegistry(tx: Db): Promise<RegistryPolicy> {
  const [policy] = await tx<RegistryPolicy[]>`SELECT target_enabled,enabled_count,policy_version FROM source_registry_policy WHERE singleton FOR UPDATE`;
  if (!policy) throw new SourceRegistryConflict("Source registry policy missing");
  return policy;
}

export async function registryChange<T>(fn: (tx: Tx, policy: RegistryPolicy) => Promise<T>): Promise<T> {
  try { return await sql.begin(async tx => fn(tx, await lockRegistry(tx))) as T; }
  catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === "source_registry_capacity") throw new SourceCapacityExceeded("Enabled source capacity exhausted");
    throw error;
  }
}

/** Explicit activation changes policy only, never rewrites the operator's source registry. */
export async function setRegistryTarget(target: number | null, expectedEnabled: number, actor: string, reason: string) {
  if ((target !== null && (!Number.isSafeInteger(target) || target < 0)) || !reason.trim()) throw new SourceRegistryConflict("Target and reason required");
  return registryChange(async (tx, policy) => {
    const [{ count }] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM sources WHERE enabled`;
    if (count !== expectedEnabled || count !== policy.enabled_count) throw new SourceRegistryConflict("Enabled count changed or counter differs");
    if (target !== null && count > target) throw new SourceCapacityExceeded("Current enabled count exceeds requested target");
    const [after] = await tx`UPDATE source_registry_policy SET target_enabled=${target},policy_version=policy_version+1,
      updated_at=now(),updated_by=${actor},reason=${reason} WHERE singleton RETURNING *`;
    await audit(actor,"source.registry-policy",null,reason,policy,after,undefined,tx);
    return after;
  });
}

export async function quarantineSubmission(tx: Db, sourceId: string, payload: unknown, client = "ingest-items") {
  let encoded: string;
  try { encoded = stableJson(payload); } catch { throw new SourceRegistryConflict("Submission payload must be JSON"); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 512 * 1024 || sourceId.length > 120 || !sourceId || client.length > 120 || !client) throw new SourceRegistryConflict("Submission evidence exceeds bounds");
  const [row] = await tx<{ id: number }[]>`INSERT INTO ingest_source_submissions(requested_source_id,client,payload_hash,payload)
    VALUES(${sourceId},${client},${sha256(encoded)},${tx.json(JSON.parse(encoded))})
    ON CONFLICT(requested_source_id,client,payload_hash) DO UPDATE SET payload_hash=EXCLUDED.payload_hash RETURNING id`;
  return row!.id;
}

/** Shared HTTP/curated gate: known paused stays paused; unknown managed delivery stays evidence only. */
export async function resolveIngestSource(sourceId: string, sourceName: string, payload: unknown, client = "ingest-items") {
  const known = await sql`SELECT id,participation_mode,enabled,config FROM sources WHERE id=${sourceId}`;
  if (known[0]) return { source: known[0], quarantined: false as const };
  return registryChange(async (tx, policy) => {
    const [existing] = await tx`SELECT id,participation_mode,enabled,config FROM sources WHERE id=${sourceId} FOR UPDATE`;
    if (existing) return { source: existing, quarantined: false as const };
    if (policy.target_enabled !== null) return { quarantined: true as const, submissionId: await quarantineSubmission(tx,sourceId,payload,client) };
    const [source] = await tx`INSERT INTO sources(id,name,kind,config,tier,participation_mode,interval_minutes,enabled,health,tags)
      VALUES(${sourceId},${sourceName},'external','{}','T2','isolated',1440,true,'ok',${['ingest:auto-created']})
      RETURNING id,participation_mode,enabled,config`;
    return { source, quarantined: false as const };
  });
}
