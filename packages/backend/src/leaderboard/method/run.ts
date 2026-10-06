// One leaderboard computation round: build inputs from the latest snapshots, compute every board
// with method v15, and publish only when the evidence changed and every published board solved
// to optimality. A failed round keeps the previous published run on the site.
import { newArticleId, sha256, stableJson } from "../../lib/ids.ts";
import { sql } from "../../db.ts";
import { buildRunInputs, type RunInputs } from "./inputs.ts";
import { BUDGETS, METHOD_VERSION } from "./v15.ts";
import { computeBoardsInWorker } from "./compute.ts";

export const TIE_POLICY = "published-order-then-slug/highs-js";
const PUBLIC_BOARDS = ["overall", "coding", "reasoning", "knowledge", "professional"];

export interface RoundResult {
  status: "published" | "unchanged" | "failed";
  runId: string | null;
  fingerprint: string;
  boards: Array<{ board: string; models: number; optimal: boolean; ms: number }>;
  reason?: string;
}

/** Everything that can change a ranking, and nothing that cannot (fetch times, verification stamps). */
export function inputFingerprint(inputs: RunInputs): string {
  return sha256(stableJson({ method: METHOD_VERSION, boards: inputs.boards }));
}

async function recordCheck(fingerprint: string, at: Date) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('leaderboard.last_check', ${sql.json({ at: at.toISOString(), fingerprint })}, 'worker')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export async function runLeaderboardRound(opts: { at?: Date; force?: boolean } = {}): Promise<RoundResult> {
  const at = opts.at ?? new Date();
  const inputs = await buildRunInputs({ at });
  const fingerprint = inputFingerprint(inputs);
  const [latest] = await sql<{ id: string; fingerprint: string | null }[]>`
    SELECT id, summary->'consensus'->>'fingerprint' AS fingerprint FROM lb_runs
    WHERE status = 'published' ORDER BY generated_at DESC LIMIT 1`;
  if (!opts.force && latest?.fingerprint === fingerprint) {
    await recordCheck(fingerprint, at);
    return { status: "unchanged", runId: latest.id, fingerprint, boards: [] };
  }

  const { outputs, timings } = await computeBoardsInWorker(inputs.boards);

  // A published board must solve to optimality over one connected evidence network.
  const broken = outputs.filter((o) => PUBLIC_BOARDS.includes(o.board) && (!o.solver.optimal || !o.publishable_connectivity));
  const overall = outputs.find((o) => o.board === "overall");
  const reason = !overall ? "overall board has no evidence" : broken.length ? `not publishable: ${broken.map((b) => b.board).join(", ")}` : undefined;

  const [fx] = await sql<{ as_of: Date; rate: number; source_name: string; source_url: string | null }[]>`
    SELECT as_of, rate, source_name, source_url FROM fx_rates WHERE pair = 'USD/CNY' ORDER BY as_of DESC LIMIT 1`;
  const runId = newArticleId();
  const summary = {
    budgets: BUDGETS,
    fxQuote: fx ? { asOf: fx.as_of.toISOString().slice(0, 10), rate: fx.rate, sourceName: fx.source_name, sourceUrl: fx.source_url } : null,
    sources: inputs.sources,
    categories: inputs.categories,
    consensus: {
      input: inputs.boards,
      boards: outputs,
      version: METHOD_VERSION,
      evidence: inputs.evidence,
      tiePolicy: TIE_POLICY,
      fingerprint,
      calculatedAt: new Date().toISOString(),
    },
    timings,
  };
  const status = reason ? "failed" : "published";
  await sql.begin(async (tx) => {
    await tx`INSERT INTO lb_runs (id, methodology_version, generated_at, source_snapshot_ids, summary, status, origin)
             VALUES (${runId}, ${METHOD_VERSION}, ${at}, ${inputs.snapshotIds}, ${tx.json(summary as never)}, ${status}, 'computed')`;
    if (status !== "published") return;
    const ids = new Map((await tx<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models WHERE slug = ANY(${outputs.flatMap((o) => o.entries.map((e) => e.slug))})`).map((r) => [r.slug, r.id]));
    for (const out of outputs) {
      const rows = out.entries
        .filter((e) => ids.has(e.slug))
        .map((e) => ({
          run_id: runId,
          board: out.board,
          model_id: ids.get(e.slug)!,
          rank: e.rank,
          score: e.score,
          coverage: e.coverage,
          metric_count: e.source_count,
          summary: `${e.source_count} 项评测 · ${e.operator_count} 家机构`,
          detail: { stability: e.stability, sourceCount: e.source_count, operatorCount: e.operator_count },
        }));
      for (let i = 0; i < rows.length; i += 500) await tx`INSERT INTO lb_rankings ${tx(rows.slice(i, i + 500) as never)}`;
    }
  });
  await recordCheck(fingerprint, at);
  return { status, runId, fingerprint, boards: timings, reason };
}
