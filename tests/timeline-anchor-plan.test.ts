import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { CJK_COPY_PATTERN } from "@aihot/contracts/copy";
import { closeDb, sql } from "@aihot/backend/db";

after(closeDb);
test("Chinese anchor covering index needs custom planning and preserves dirty-row release/withdrawal results", async () => {
  const db = await sql.reserve();
  const schema = `timeline_plan_${Date.now()}`;
  const query = `WITH base AS (
    SELECT sort_at,coalesce('s'||story_id::text,'f'||fact_id::text,'a'||article_id) AS gk
    FROM publications WHERE visibility='public' AND selected AND visible_after <= $1 AND title ~ $2
  ), waiting AS (
    SELECT min(visible_after) AS t FROM publications
    WHERE visibility='public' AND selected AND visible_after > $1 AND title ~ $2
  ) SELECT g.gk,g.anchor_at,waiting.t AS pending_at
    FROM waiting LEFT JOIN (SELECT gk,max(sort_at) AS anchor_at FROM base GROUP BY gk) g ON true
    ORDER BY g.anchor_at DESC NULLS LAST,g.gk COLLATE "C" DESC`;
  const migration = readFileSync(new URL("../database/migrations/0069_timeline_anchor_covering.sql", import.meta.url), "utf8");
  assert.ok(migration.includes(`title ~ '${CJK_COPY_PATTERN}'`), "frozen DDL must match the live Chinese-copy gate");
  const source = readFileSync(new URL("../packages/backend/src/publication/timeline.ts", import.meta.url), "utf8");
  assert.match(source.slice(source.indexOf("async function queryGroupedAnchors")), /const rows = await withCustomPlans\(/);
  const now = new Date("2026-10-19T10:00:00Z");
  const execute = `EXECUTE timeline_anchor_probe('${now.toISOString()}','${CJK_COPY_PATTERN}')`;
  const plan = async (analyze = false) => (await db.unsafe(`EXPLAIN (${analyze ? "ANALYZE, BUFFERS, TIMING OFF," : ""} FORMAT JSON) ${execute}`))[0]!["QUERY PLAN"][0];
  const nodes = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
  try {
    await db`CREATE SCHEMA ${db(schema)}`;
    await db`SET search_path TO ${db(schema)}`;
    await db`CREATE TABLE publications(article_id text PRIMARY KEY,visibility text,selected boolean,title text,
      visible_after timestamptz,sort_at timestamptz,story_id bigint,fact_id bigint,payload text)`;
    await db`INSERT INTO publications SELECT n::text,'public',n%9=0,
      CASE WHEN n%100=0 THEN 'English' ELSE '地理'||md5(n::text) END,
      ${now}::timestamptz-interval '1 day',${now}::timestamptz-n*interval '1 minute',
      CASE WHEN n%18=0 THEN n/18 END,NULL,repeat(md5(n::text),80) FROM generate_series(1,60000)n`;
    await db`CREATE INDEX old_release ON publications(visible_after) WHERE visibility='public' AND selected`;
    await db`VACUUM ANALYZE publications`;
    await db.unsafe(`PREPARE timeline_anchor_probe(timestamptz,text) AS ${query}`);
    const before = await db.unsafe(execute);
    const oldPlan = await plan(true);
    await db.unsafe(migration);
    await db`SET plan_cache_mode=force_generic_plan`;
    assert.equal(nodes((await plan()).Plan).some((n) => n["Index Name"] === "publications_selected_zh_anchor_idx"), false,
      "a generic pattern parameter cannot imply this constant partial predicate");
    await db`SET plan_cache_mode=force_custom_plan`;
    const improved = await plan(true);
    const covering = nodes(improved.Plan).filter((n) => n["Index Name"] === "publications_selected_zh_anchor_idx");
    assert.equal(covering.length, 2, "both anchor input and next-release read should use the narrow index");
    assert.ok(covering.every((n) => n["Node Type"] === "Index Only Scan" && n["Heap Fetches"] === 0));
    assert.ok(improved.Plan["Shared Hit Blocks"] + improved.Plan["Shared Read Blocks"] < oldPlan.Plan["Shared Hit Blocks"] + oldPlan.Plan["Shared Read Blocks"],
      "the vacuumed realistic fixture should need fewer buffers, not merely a differently named index");
    assert.deepEqual(await db.unsafe(execute), before);
    await db`UPDATE publications SET title='地理'||repeat(md5('wide-title'),1000) WHERE article_id='9'`;
    assert.deepEqual(await db.unsafe(execute), before, "wide titles are predicate inputs, never oversized INCLUDE payloads");
    await db`UPDATE publications SET title='English correction' WHERE article_id='9'`;
    await db`UPDATE publications SET visibility='withdrawn' WHERE article_id='27'`;
    await db`UPDATE publications SET visible_after=${new Date(now.getTime() + 60000)} WHERE article_id='45'`;
    const changed = await db.unsafe(execute);
    assert.equal(changed.length, before.length - 3);
    assert.equal(changed[0]!.pending_at.toISOString(), new Date(now.getTime() + 60000).toISOString());
    assert.ok(!changed.some((r) => ["a9", "a27", "a45"].includes(r.gk)));
    // Dirty visibility-map pages may require heap fetches, but cannot leak corrections/withdrawals.
    assert.ok(nodes((await plan(true)).Plan).some((n) => Number(n["Heap Fetches"]) > 0));
    await db`UPDATE publications SET visible_after=${new Date(now.getTime() - 1)} WHERE article_id='45'`;
    assert.equal((await db.unsafe(execute)).length, before.length - 2);
  } finally {
    await db`DEALLOCATE ALL`;
    await db`SET plan_cache_mode=auto`;
    await db`SET search_path TO public`;
    await db`DROP SCHEMA IF EXISTS ${db(schema)} CASCADE`;
    db.release();
  }
});
