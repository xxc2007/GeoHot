import { sql } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { lockRegistry } from "./registry.ts";
import { fetchRss } from "./rss.ts";
import { fetchJsonList } from "./json-list.ts";
import type { SourceRow } from "./types.ts";
import { setTimeout as delay } from "node:timers/promises";

// Free scholarly APIs also have fair-use limits; reserve verification must not burst requests.
let nextScholarlyProbe = 0;

/** Public feed probes do not store articles, spend model budget or enqueue content. */
export async function validateReserve(source: SourceRow) {
  if (source.kind !== "rss" && source.kind !== "json_list") throw new Error("Only verified public RSS/JSON reserves are supported");
  if (String(source.config.url ?? "").startsWith("https://api.crossref.org/")) {
    const slot=Math.max(Date.now(),nextScholarlyProbe);nextScholarlyProbe=slot+1800;
    if(slot>Date.now())await delay(slot-Date.now());
  }
  const candidates = source.kind === "rss" ? (await fetchRss({ ...source, cursor: null }, { force: true })).candidates : await fetchJsonList(source);
  const items = candidates.filter(x => x.title?.trim() && x.url);
  if (!items.length) throw new Error("No readable feed entries");
  const dates = items.map(x => x.publishedAt ? Date.parse(String(x.publishedAt)) : NaN).filter(Number.isFinite);
  const latest = dates.length ? Math.max(...dates) : 0;
  if (latest < Date.now() - 400 * 86400_000 || latest > Date.now() + 86400_000) throw new Error("No recent dated feed entries");
  return { items: items.length, latest: new Date(latest).toISOString() };
}

/** Lock + compare the evidence again: two workers cannot consume the same reserve or reduce capacity. */
export async function swapReserve(failedId: string, reserveId: string, validation: unknown) {
  return sql.begin(async tx => {
    const policy = await lockRegistry(tx);
    const [settings] = await tx`SELECT automatic_failover FROM source_registry_policy WHERE singleton`;
    if (!settings?.automatic_failover || policy.target_enabled === null) return false;
    const [daily] = await tx`SELECT count(*)::int AS n FROM audit_log WHERE action='source.auto-replace' AND created_at>now()-interval '24 hours'`;
    const [outage] = await tx`SELECT count(*) FILTER(WHERE health='failing')::int AS bad,count(*)::int AS n FROM sources WHERE enabled`;
    if(daily!.n>=12 || outage!.bad>=Math.max(10,outage!.n/10)) return false;
    const rows = await tx`SELECT * FROM sources WHERE id IN (${failedId},${reserveId}) ORDER BY id FOR UPDATE`;
    const old = rows.find(x => x.id === failedId), next = rows.find(x => x.id === reserveId);
    if ((await tx`SELECT 1 FROM source_retirements WHERE source_id IN (${failedId},${reserveId})`).length) return false;
    const [eligible] = await tx`SELECT * FROM source_reserves WHERE source_id=${reserveId} AND eligible AND validated_at > now()-interval '7 days' FOR UPDATE`;
    if (!old?.enabled || next?.enabled !== false || !eligible || old.fail_count < 5 || old.health !== "failing") return false;
    if (!old.last_fetch_at || Date.parse(String(old.last_fetch_at)) < Date.now()-6*3600_000 || (old.last_ok_at && Date.parse(String(old.last_ok_at)) > Date.now()-24*3600_000)) return false;
    if (/budget|rate.limit|quota|429|预算|限流/i.test(old.last_error ?? "")) return false;
    const [count] = await tx`SELECT count(*)::int AS n FROM sources WHERE enabled`;
    if (count!.n !== policy.target_enabled || count!.n !== policy.enabled_count) return false;
    await tx`UPDATE sources SET enabled=false,health='paused',updated_at=now() WHERE id=${failedId}`;
    await tx`UPDATE sources SET enabled=true,health='unknown',fail_count=0,last_error=NULL,next_fetch_at=now(),updated_at=now() WHERE id=${reserveId}`;
    await tx`DELETE FROM source_reserves WHERE source_id=${reserveId}`;
    await tx`INSERT INTO source_reserves(source_id,validated_at,validation,eligible,next_check_at)
      VALUES(${failedId},now(),${tx.json({ reason: "automatic failure quarantine" })},false,now()+interval '24 hours')
      ON CONFLICT(source_id) DO UPDATE SET eligible=false,next_check_at=now()+interval '24 hours'`;
    await audit("sources.failover","source.auto-replace",`source:${failedId}`,"连续失败至少5次且24小时无成功；备用源即时复核通过",old,{ replacement: reserveId, validation },undefined,tx);
    return true;
  });
}

/** A bounded, serial maintenance round. Stop on broad outages instead of rotating the whole pool. */
export async function maintainReserves() {
  const [policy] = await sql`SELECT automatic_failover,target_enabled FROM source_registry_policy WHERE singleton`;
  if (!policy?.automatic_failover) return { checked: 0, replaced: 0, state: "disabled" };
  let checked = 0, replaced = 0;
  const candidates = await sql<(SourceRow & { default_category: string | null })[]>`
    SELECT s.* FROM source_reserves r JOIN sources s ON s.id=r.source_id
    WHERE NOT s.enabled AND r.next_check_at<=now() AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)
    ORDER BY r.next_check_at,r.priority DESC,s.id LIMIT 4`;
  for (const s of candidates) {
    // Claim before I/O, so overlapping cron rounds do not probe the same feed.
    const claim = await sql`UPDATE source_reserves SET next_check_at=now()+interval '1 day' WHERE source_id=${s.id} AND next_check_at<=now() RETURNING source_id`;
    if (!claim.length) continue;
    checked++;
    try { const evidence = await validateReserve(s); await sql`UPDATE source_reserves SET eligible=true,validated_at=now(),validation=${sql.json(evidence)} WHERE source_id=${s.id}`; }
    catch (e) {
      const error=String(e).slice(0,400);
      if(/429|rate.limit/i.test(error)) await sql`UPDATE source_reserves SET next_check_at=now()+interval '1 hour',validation=validation || ${sql.json({lastProbeError:error})}::jsonb WHERE source_id=${s.id}`;
      else await sql`UPDATE source_reserves SET eligible=false,validation=${sql.json({ error })} WHERE source_id=${s.id}`;
    }
  }
  const [health] = await sql`SELECT count(*)::int AS n,count(*) FILTER(WHERE health='failing')::int AS bad FROM sources WHERE enabled`;
  const [daily] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='source.auto-replace' AND created_at>now()-interval '24 hours'`;
  if (!health || health.bad >= Math.max(10,health.n/10) || daily!.n >= 12) return { checked,replaced,state: "outage-or-daily-limit" };
  const failed = await sql`SELECT id,default_category,first_party,config FROM sources WHERE enabled AND health='failing' AND fail_count>=5
    AND last_fetch_at>now()-interval '6 hours' AND (last_ok_at IS NULL OR last_ok_at<now()-interval '24 hours')
    AND coalesce(last_error,'') !~* 'budget|rate.limit|quota|429|预算|限流' ORDER BY last_ok_at NULLS FIRST,id LIMIT 2`;
  for (const old of failed) {
    const choices = await sql<SourceRow[]>`SELECT s.* FROM source_reserves r JOIN sources s ON s.id=r.source_id
      WHERE NOT s.enabled AND r.eligible AND r.validated_at>now()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM source_retirements t WHERE t.source_id=s.id)
      AND (s.default_category=${old.default_category}::text OR s.default_category IS NULL OR ${old.default_category}::text IS NULL)
      ORDER BY (s.default_category IS NOT DISTINCT FROM ${old.default_category}::text) DESC,
        (s.first_party=${old.first_party}::boolean) DESC,r.priority DESC,r.validated_at DESC,s.id LIMIT 2`;
    for (const next of choices) {
      try { const evidence=await validateReserve(next); if(await swapReserve(old.id,next.id,evidence)) {replaced++;break;} }
      catch(e) {
        const error=String(e).slice(0,400);
        if(/429|rate.limit/i.test(error)) break;
        await sql`UPDATE source_reserves SET eligible=false,validation=${sql.json({error})} WHERE source_id=${next.id}`;
      }
    }
  }
  return { checked,replaced,state: "ok" };
}
