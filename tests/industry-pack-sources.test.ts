// The industry pack's source list is data-as-code: `scripts/seed.ts` only checks these rules when a
// database is reachable, so a bad entry used to be caught at deploy time rather than in CI. Checked
// here instead — the same three rules, without a database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import { ENTITIES } from "@aihot/industry/taxonomy";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { noiseFiltered } from "@aihot/backend/sources/collect";

interface PackSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
  config: Record<string, unknown>;
  owner_entity_id?: string | null;
  participation_mode: string;
  interval_minutes: number;
  enabled: boolean;
  defaultCategory?: string;
}

const sources = (JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: PackSource[] }).sources;

test("every registered config is one its kind actually implements", () => {
  for (const s of sources) assertSupportedConfig(s.kind, s.config);
});

test("every default category names a real section", () => {
  for (const s of sources) {
    if (s.defaultCategory !== undefined) assert.ok(isCategoryKey(s.defaultCategory), `${s.id}: defaultCategory ${s.defaultCategory}`);
  }
});

test("an owner is either nothing or a key of the entity table", () => {
  // writing.ts:133 resolves the owner through IDENTITY_LEXICON, and a value only it knows silently reads
  // as "no publisher" — the pack's own rule is that a non-null owner is an ENTITIES key.
  for (const s of sources) {
    if (s.owner_entity_id !== null && s.owner_entity_id !== undefined) {
      assert.ok(Object.hasOwn(ENTITIES, s.owner_entity_id), `${s.id}: owner_entity_id "${s.owner_entity_id}" is not an ENTITIES key`);
    }
  }
});

test("a source billed per request is registered stopped", () => {
  // x_search needs SOCIALDATA_API_KEY and mp_account needs DAJIALA_KEY. This deployment has neither, so an
  // enabled entry of those kinds would schedule a paid call that can only fail.
  for (const s of sources) {
    if (s.kind === "x_search" || s.kind === "mp_account") {
      assert.equal(s.enabled, false, `${s.id}: a per-request source must be registered with enabled=false`);
    }
  }
});

test("ids and names are unique and each source has a polling interval", () => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const s of sources) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    assert.ok(!names.has(s.name), `duplicate name ${s.name}`);
    ids.add(s.id);
    names.add(s.name);
    if (s.kind !== "external") assert.ok(Number.isFinite(s.interval_minutes) && s.interval_minutes >= 15, `${s.id}: interval ${s.interval_minutes}`);
  }
});

test("a noise list has to match what the feed actually prints", () => {
  // 2026-10-08 实测：PNAS 的目录里印的是 "Retraction for Lin and Lee, …"，而 dropMarkersTitleOnly 里
  // 写的是 "Retractions"。markerPattern 把 marker 变成 `retractionss?`（collect.ts:44），一条也匹配不上；
  // 卷首语 "In This Issue" 每期都是新 URL，也没有任何规则挡它。这两族每条都会跑一次付费分析。
  const byId = new Map(sources.map((s) => [s.id, s]));
  const pnas = byId.get("rss-pnas-toc");
  assert.ok(pnas, "rss-pnas-toc 还在包里");
  const c = (title: string) => ({ url: "https://www.pnas.org/doi/abs/10.1073/itest", title, excerpt: "" }) as never;
  for (const noise of [
    "Retraction for Lin and Lee, A dual self-regulatory platform for transcription",
    "In This Issue",
    "Reply to Y. Zhang et al., Comment on “…”, Correction for",
  ]) {
    assert.equal(noiseFiltered(c(noise), pnas as never), true, `这一条应当被丢掉：${noise.slice(0, 40)}`);
  }
  assert.equal(noiseFiltered(c("Meteoritic organic matter records primitive oxygen reservoirs of the solar system"), pnas as never), false, "真正的研究论文不能被丢掉");
  // IFRC 把同一条公告印两次：一次带 slug，一次是裸的 Drupal 节点号（实测同一标题、相隔 55 秒）。
  const ifrc = byId.get("rss-ifrc-news")!;
  assert.deepEqual(ifrc.config.denyUrlPrefixes, ["https://www.ifrc.org/node/"], "IFRC 的 /node/ 重复条目需要 deny 前缀");
  // 周刊性质的目录不能跟着流量走：adaptIntervals 读的是"过去七天进了多少条"，不是"这份刊物多久出一期"，
  // 一周 90 条会把它的抓取间隔压到 36 分钟，之后六天都在反复读同一份目录。
  for (const id of ["rss-pnas-toc", "rss-nature-geoscience", "rss-nature-climate-change", "rss-nature-comm-earth-environment", "rss-nature-cities", "rss-nature-water", "rss-nature-sustainability", "rss-nature-food"]) {
    const cfg = byId.get(id)!.config._aihot as Record<string, unknown> | undefined;
    assert.equal(cfg?.intervalMinutesLocked, true, `${id}: 期刊目录的节奏是人工决定，必须 intervalMinutesLocked`);
  }
});
