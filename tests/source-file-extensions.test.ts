import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allowed } from "@aihot/backend/sources/web-list";
import { applySourceFilters } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { ENTITIES, IDENTITY_LEXICON } from "@aihot/industry/taxonomy";

const source = { config: { denyUrlFileExtensions: ["png", "jpeg", "jpg", "gif", "webp", "svg", "ico"] } } as never;
const base = "https://www.gov.br/cemaden/pt-br/assuntos/riscos-geo-hidrologicos/forecast";

test("file rules inspect the terminal filename and optional single /view wrapper", () => {
  for (const path of ["/map.png", "/map.PNG/view", "/map.jpeg/view/", "/map%2Ejpg", "/map.svg?download=1", "/map.webp#figure"]) {
    assert.equal(allowed(base + path, source), false, path);
  }
  for (const path of ["", "-1", "/report.pdf", "/png-science", "?image=map.png", "/map.png/article", "/map.png/view/article", "/map.png/view/view"]) {
    assert.equal(allowed(base + path, source), true, path);
  }
  assert.equal(allowed(base + "/map.png", { config: {} } as never), true, "opt-in only");
  assert.equal(allowed(base + "/bad%ZZ.png", source), false, "invalid filename encoding is refused");
  assert.equal(allowed("not a URL", source), false);
});

test("extension configuration is bounded data, never an arbitrary regular expression", () => {
  for (const kind of ["rss", "web_list", "json_list"] as const) {
    for (const value of [undefined, null, [], ["png", "JPG", "7z"]]) {
      assert.deepEqual(unsupportedConfig(kind, { denyUrlFileExtensions: value }), []);
    }
    for (const value of ["png", {}, [null], [""], [".png"], ["png|jpg"], ["x".repeat(13)], ["图"], Array(33).fill("png")]) {
      assert.equal(unsupportedConfig(kind, { denyUrlFileExtensions: value }).length, 1, JSON.stringify(value));
    }
  }
  assert.deepEqual(unsupportedConfig("external", { denyUrlFileExtensions: ["png"] }), ["denyUrlFileExtensions"]);
});

test("the shared filter used by news RSS backfill keeps parent articles and PDF reports", () => {
  const items = [base, base + "/figure.png/view", base + "/report.pdf"].map((url) => ({ title: "Forecast", url }));
  assert.deepEqual(applySourceFilters(items, source).map((a) => a.url), [base, base + "/report.pdf"]);
  const archive = readFileSync(new URL("../scripts/backfill-news.ts", import.meta.url), "utf8");
  assert.match(archive, /return applySourceFilters\(\(await fetchRss/);
});

test("the five owner updates reference precise entities without visible topic changes", () => {
  const pack = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")).sources;
  const byId = new Map<string, any>(pack.map((s: any) => [s.id, s]));
  assert.equal(pack.filter((s: any) => s.enabled !== false).length, 666);
  for (const [id, owner] of Object.entries({ "br-cemaden-rss": "cemaden", "gt-esa-eo-news": "esa", "eu-esa-copernicus-feed": "esa", "rss-uk-govuk-envagency": "uk-environment-agency", "gb-govuk-defra-atom": "uk-defra" })) {
    assert.equal(byId.get(id).owner_entity_id, owner);
    assert.ok(Object.hasOwn(ENTITIES, owner));
    assert.ok(IDENTITY_LEXICON.some((e) => e.id === owner));
  }
  for (const id of ["cemaden", "uk-defra", "uk-environment-agency"]) assert.equal(ENTITIES[id]!.displayTag, null);
  const agency = IDENTITY_LEXICON.find((e) => e.id === "uk-environment-agency")!;
  assert.ok(agency.patterns.some((p) => p.test("UK Environment Agency")));
  assert.equal(agency.patterns.some((p) => p.test("Ghana Environment Agency")), false, "generic agency names do not prove a UK identity");
  const cemaden = byId.get("br-cemaden-rss");
  assert.equal(cemaden.config.feedUrl, "https://www.gov.br/cemaden/rss.xml");
  assert.ok(cemaden.tags.includes("葡萄牙文"));
  assert.equal(cemaden.tags.includes("英文"), false);
  assert.equal(cemaden.site_fulltext, false);
  assert.equal(cemaden.syndicate_fulltext, false);
  assert.deepEqual(pack.filter((s: any) => s.config.denyUrlFileExtensions).map((s: any) => s.id), ["br-cemaden-rss"]);
});
