// Live operations board for the model layer: what is being called right now, how it is doing, and which
// pool each capability is drawing from. Read-only; writes live in `setCapabilityPool` (admin/models.ts).
import { sql } from "../db.ts";
import { CAPABILITIES } from "../editorial/models.ts";

export type ModelOpsRow = {
  service: string;
  model: string;
  calls: number;
  ok: number;
  bad: number;
  avgMs: number;
  tokens: number;
  cost: number;
};

export type ModelOps = {
  at: string;
  windowMinutes: number;
  models: ModelOpsRow[];
  series: { minute: string; calls: number; bad: number }[];
  queue: { state: string; n: number }[];
  active: { name: string; n: number }[];
  heartbeats: { key: string; role: string; at: string | null; load: number | null }[];
  capabilities: { key: string; label: string; source: "admin" | "env" | "default"; members: string[] }[];
};

/** Per-capability pool: admin override wins, then the capability's own env, then MODEL_POOL. */
async function capabilityPools() {
  const overrides = new Map<string, string>();
  try {
    const rows = await sql<{ key: string; value: { model?: string } }[]>`
      SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
    for (const row of rows) {
      const value = row.value?.model;
      if (typeof value === "string" && value.trim()) overrides.set(row.key.slice("models.".length), value.trim());
    }
  } catch {
    // The board is diagnostic: if settings cannot be read, show env values rather than nothing.
  }
  return Object.entries(CAPABILITIES).map(([key, c]) => {
    const admin = overrides.get(key);
    const env = process.env[(c as { env: string }).env];
    const raw = admin ?? env ?? process.env.MODEL_POOL ?? "";
    const source: "admin" | "env" | "default" = admin ? "admin" : env ? "env" : "default";
    const members = raw.split(",").map((m) => m.trim()).filter(Boolean);
    return { key, label: (c as { label: string }).label, source, members };
  });
}

export async function loadModelOps(windowMinutes = 60): Promise<ModelOps> {
  const window = Math.max(10, Math.min(360, Math.floor(windowMinutes)));
  const since = new Date(Date.now() - window * 60_000);

  const [models, series, queue, active, beats, capabilities] = await Promise.all([
    sql<ModelOpsRow[]>`
      SELECT service,
             coalesce(model, '-') AS model,
             count(*)::int AS calls,
             count(*) FILTER (WHERE status = 'ok')::int AS ok,
             count(*) FILTER (WHERE status <> 'ok')::int AS bad,
             round(avg(extract(epoch FROM (coalesce(completed_at, now()) - created_at)) * 1000))::int AS "avgMs",
             coalesce(sum(coalesce((usage->>'total_tokens')::int, 0)), 0)::bigint AS tokens,
             coalesce(sum(cost), 0)::float8 AS cost
        FROM receipts
       WHERE created_at > ${since}
       GROUP BY service, model
       ORDER BY calls DESC
       LIMIT 24`,
    sql<{ minute: string; calls: number; bad: number }[]>`
      SELECT to_char(date_trunc('minute', created_at), 'HH24:MI') AS minute,
             count(*)::int AS calls,
             count(*) FILTER (WHERE status <> 'ok')::int AS bad
        FROM receipts
       WHERE created_at > ${since}
       GROUP BY 1
       ORDER BY 1`,
    sql<{ state: string; n: number }[]>`
      SELECT state, count(*)::int AS n FROM pgboss.job GROUP BY state ORDER BY n DESC`,
    sql<{ name: string; n: number }[]>`
      SELECT name, count(*)::int AS n FROM pgboss.job WHERE state = 'active' GROUP BY name ORDER BY n DESC LIMIT 10`,
    sql<{ key: string; role: string; at: string | null; load: number | null }[]>`
      SELECT key, updated_by AS role, value->>'at' AS at, (value->>'load')::float8 AS load
        FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY updated_at DESC LIMIT 8`,
    capabilityPools(),
  ]);

  return {
    at: new Date().toISOString(),
    windowMinutes: window,
    models,
    series,
    queue,
    active,
    heartbeats: beats.map((b) => ({ ...b, tokens: undefined })) as ModelOps["heartbeats"],
    capabilities,
  };
}
