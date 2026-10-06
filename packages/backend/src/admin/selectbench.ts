// SelectBench: selection-model comparison runs on the human gold set. Runs come from
// scripts/eval-selection.ts (imported automatically) or an uploaded report; the admin compares
// models on the same cases and browses each case.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "../db.ts";
import { InvalidInput } from "./invalid.ts";
import { audit } from "./auth.ts";

interface ModelReport {
  summary: Record<string, unknown>;
  sweep?: unknown[];
  cases?: CaseIn[];
}

/**
 * One case of an imported report. Everything here arrives as `unknown` from an uploaded JSON file or
 * `scripts/eval-selection.ts`, and unvalidated values used to reach the INSERT: a wrong type came back
 * from Postgres as a 500 for what is really a bad file. Types and requiredness are checked (the NOT NULL
 * columns are `case_id`, `title`, `gold`; `score`/`receipt_id` are numeric); no length caps, because the
 * text columns have none and a long source title is not the operator's mistake.
 */
const CaseSchema = z.object({
  caseId: z.string().min(1),
  title: z.string(),
  stratum: z.string().nullish(),
  gold: z.string().min(1),
  decision: z.string().nullish(),
  score: z.number().nullish(),
  relevance: z.string().nullish(),
  category: z.string().nullish(),
  reason: z.string().nullish(),
  receiptId: z.number().int().nonnegative().nullish(),
  error: z.string().nullish(),
});
type CaseIn = z.infer<typeof CaseSchema>;

const MetaSchema = z.object({
  n: z.number().int().nonnegative().optional(),
  seed: z.number().int().optional(),
  split: z.string().optional(),
  promptVersion: z.string().optional(),
});

/** Accepts { meta, models } or the older report shape keyed by model name. */
export async function importSelectBenchRun(report: unknown, label: string, actor: string) {
  const r = report as { meta?: Record<string, unknown>; models?: Record<string, ModelReport> } & Record<string, ModelReport>;
  const models = (r.models ?? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "meta"))) as Record<string, ModelReport>;
  const names = Object.keys(models).filter((m) => models[m]?.summary);
  if (!names.length) throw new InvalidInput("report has no model summaries");
  const meta = MetaSchema.parse(r.meta ?? {});
  const id = `sb-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
  const summary = Object.fromEntries(names.map((m) => [m, { ...models[m]!.summary, sweep: models[m]!.sweep ?? [] }]));
  const sampleSize = Number(meta.n ?? (models[names[0]!]!.summary as { n?: number }).n ?? 0);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO selectbench_runs (id, label, split, sample_size, seed, prompt_version, models, summary, imported_by)
      VALUES (${id}, ${label}, ${meta.split ?? null}, ${sampleSize}, ${meta.seed ?? null}, ${meta.promptVersion ?? null}, ${names}, ${tx.json(summary as never)}, ${actor})`;
    for (const m of names) {
      const cases = z.array(CaseSchema).parse(models[m]!.cases ?? []);
      for (let i = 0; i < cases.length; i += 500) {
        const rows = cases.slice(i, i + 500).map((c) => ({
          run_id: id,
          model: m,
          case_id: c.caseId,
          title: c.title,
          stratum: c.stratum ?? null,
          gold: c.gold,
          decision: c.decision,
          score: c.score ?? null,
          relevance: c.relevance ?? null,
          category: c.category ?? null,
          reason: c.reason ?? null,
          receipt_id: c.receiptId ?? null,
          error: c.error ?? null,
        }));
        await tx`INSERT INTO selectbench_results ${tx(rows)} ON CONFLICT DO NOTHING`;
      }
    }
  });
  await audit(actor, "selectbench.import", `selectbench:${id}`, null, null, { label, models: names, sampleSize });
  return { id };
}

export async function listSelectBenchRuns() {
  return sql`
    SELECT r.id, r.label, r.split, r.sample_size, r.prompt_version, r.models,
           (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
           r.created_at, r.imported_by,
           (SELECT count(*)::int FROM selectbench_results x WHERE x.run_id = r.id) AS cases
    FROM selectbench_runs r ORDER BY r.created_at DESC LIMIT 100`;
}

export async function selectBenchRun(id: string, f: { model?: string; outcome?: string; stratum?: string; disagree?: boolean }) {
  const [run] = await sql`SELECT * FROM selectbench_runs WHERE id = ${id}`;
  if (!run) return null;
  const outcome = f.outcome ?? null;
  // One row per case with every model's decision, so disagreements are visible side by side.
  const rows = await sql`
    SELECT case_id, min(title) AS title, min(stratum) AS stratum, min(gold) AS gold,
           jsonb_object_agg(model, jsonb_build_object('decision', decision, 'score', score, 'relevance', relevance, 'category', category, 'reason', reason, 'error', error, 'receiptId', receipt_id)) AS by_model
    FROM selectbench_results WHERE run_id = ${id} AND (${f.stratum ?? null}::text IS NULL OR stratum = ${f.stratum ?? null})
    GROUP BY case_id
    HAVING (${outcome}::text IS NULL OR bool_or(
      model = ${f.model ?? (run.models as string[])[0]!} AND CASE ${outcome}
        WHEN 'fp' THEN decision = 'select' AND gold = 'reject'
        WHEN 'fn' THEN decision = 'reject' AND gold = 'select'
        WHEN 'tp' THEN decision = 'select' AND gold = 'select'
        WHEN 'tn' THEN decision = 'reject' AND gold = 'reject'
        WHEN 'either' THEN gold = 'either'
        WHEN 'error' THEN decision IS NULL
        ELSE true END))
      AND (${!!f.disagree} IS FALSE OR count(DISTINCT decision) > 1)
    ORDER BY min(stratum), case_id LIMIT 400`;
  const strata = await sql`SELECT stratum, count(DISTINCT case_id)::int AS n FROM selectbench_results WHERE run_id = ${id} GROUP BY 1 ORDER BY 2 DESC`;
  return { run, rows, strata };
}
