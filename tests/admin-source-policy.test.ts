// Admin form defaults against the published policy (AUDIT-WAVE2 W2 from the polish agent). The defect was
// real and specific: apps/web/app/routes/admin/source-new.tsx initialised `site_fulltext` to true while the
// create schema defaults it to false, the column default says false, and industry/pages/terms.md promises
// readers "默认为关". Four lists that have to agree, and nothing imported between them.
//
// The form's initial values are not importable: they are `useState` literals inside a .tsx component, and
// `node --test` has no JSX loader (only the built SSR bundle would have one). So the values are read out of
// the module source and compared against the three authorities the backend actually publishes — the create
// path, the column default and the terms page. That is a source-text read, deliberately: it is the only
// layer where this regression can be caught without touching apps/. If the form ever moves its defaults into
// an exported constant, this file should be rewritten to import it instead.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createSource } from "@aihot/backend/admin/sources";
import { assertSupportedConfig, unsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";
import { KIND_LABEL } from "../apps/web/app/features/admin/labels.ts";

const FORM = readFileSync(new URL("../apps/web/app/routes/admin/source-new.tsx", import.meta.url), "utf8");
const TERMS = readFileSync(new URL("../industry/pages/terms.md", import.meta.url), "utf8");
const PACK = (JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: Array<{ id: string; kind: string; site_fulltext?: boolean; syndicate_fulltext?: boolean }> }).sources;

/** A boolean written into the form's initial `useState` object. */
function formDefault(field: string, src = FORM): boolean {
  const state = /const \[form, setForm\] = useState\(\{([^]*?)\}\);/.exec(src)?.[1];
  assert.ok(state, "the new-source form keeps one flat useState object for its fields");
  const literal = new RegExp(`\\b${field}:\\s*(true|false)\\b`).exec(state)?.[1];
  assert.ok(literal, `${field} is given an explicit literal default in the form`);
  return literal === "true";
}

/** The config keys the form offers per kind, straight out of its TEMPLATES table. */function formTemplates(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of FORM.split(/\r?\n/)) {
    const m = /^\s*(\w+):\s*\{((?:"[^"]*"|[^}])*)\},?$/.exec(line);
    if (!m) continue;
    out[m[1]!] = [...m[2]!.replace(/"[^"]*"/g, '""').matchAll(/(\w+):/g)].map((k) => k[1]!);
  }
  return out;
}

const created: string[] = [];
after(async () => {
  for (const id of created) await sql`DELETE FROM sources WHERE id = ${id}`;
  await closeDb();
});

test("a source created through the admin path gets the licences off: the schema default is the policy", async () => {
  const id = `test-admin-defaults-${Date.now().toString(36)}`;
  created.push(id);
  // Exactly what the "新建信源" form submits when an editor touches no checkbox at all.
  const res = await createSource({ id, name: "默认值检查", kind: "rss", config: { feedUrl: "https://example.com/feed.xml" } }, "test");
  assert.equal(res.created, true, "the minimal payload the form submits is accepted");
  if (!res.created) return;
  const source = res.source as Record<string, unknown>;
  assert.equal(source.site_fulltext, false, "站内全文必须默认为关（terms 对读者的承诺）");
  assert.equal(source.syndicate_fulltext, false, "对外全文同样默认为关");
  assert.equal(source.first_party, false);
  assert.equal(source.enabled, true, "a registered source is enabled until paused");
  assert.equal(source.tier, "T2", "the tier an untouched form lands on");
  assert.equal(source.participation_mode, "editorial");
  assert.equal(source.interval_minutes, 30);
  // The public rule that reads the flag: with the default, only a summary may ever be shown.
  const [row] = await sql<{ site_fulltext: boolean }[]>`SELECT site_fulltext FROM sources WHERE id = ${id}`;
  assert.equal(row!.site_fulltext, false, "and it is the row the publication layer reads");
});

test("the database column default agrees with the admin schema, so a direct INSERT cannot open a licence by accident", async () => {
  const [def] = await sql<{ expr: string }[]>`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    JOIN pg_class c ON c.oid = d.adrelid WHERE c.relname = 'sources' AND a.attname = 'site_fulltext'`;
  assert.equal(def!.expr, "false", "0036_open_source_defaults moved this off; the original 0001 default was true");
  const [syn] = await sql<{ expr: string }[]>`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    JOIN pg_class c ON c.oid = d.adrelid WHERE c.relname = 'sources' AND a.attname = 'syndicate_fulltext'`;
  assert.equal(syn!.expr, "false");
});

test("the new-source form's defaults are the published policy, not a copy of it (the W2 regression)", async () => {
  // What the backend actually defaults, read from the create path rather than restated as a literal here:
  // a copy in this file would follow an edit to the test instead of an edit to the code it is checking.
  const probe = `test-admin-form-baseline-${Date.now().toString(36)}`;
  created.push(probe);
  // A feed URL of its own: createSource refuses a config that duplicates a source already registered, and
  // the first case's probe source is still in the database until this file's `after` runs.
  const res = await createSource({ id: probe, name: "表单基线", kind: "rss", config: { feedUrl: `https://example.com/${probe}.xml` } }, "test");
  assert.equal(res.created, true, "the baseline source the form submits is accepted");
  if (!res.created) return;
  const createdRow = res.source as Record<string, unknown>;
  for (const field of ["site_fulltext", "syndicate_fulltext", "first_party"] as const) {
    assert.equal(createdRow[field], false, `the create path itself defaults ${field} to off (got ${String(createdRow[field])})`);
    assert.equal(formDefault(field), createdRow[field],
      `admin/source-new.tsx must open with ${field}: ${String(createdRow[field])} — a form that pre-ticks a licence hands the admin a policy violation with one click on 保存`);
  }
  // The extractor is the weak link in this file, so prove it reads the literal it claims to read: the same
  // helper on a copy of the source with the old defect restored must report the defect.
  assert.equal(formDefault("site_fulltext", FORM.replace("site_fulltext: false", "site_fulltext: true")), true,
    "formDefault() actually distinguishes true from false in the form's initial state");
  // The terms page is the promise the reader can hold the site to, and it must say the same thing.
  assert.match(TERMS, /`site_fulltext`[^\n]*默认为关/, "terms.md still promises 站内全文默认为关");
  assert.match(TERMS, /`syndicate_fulltext`，默认为关/, "and the same for 对外全文");
  assert.equal(/site_fulltext[^。\n]*默认为开/.test(TERMS), false, "the promise cannot be inverted");
  // 许可位的开与关都必须是"登记过的决定"，不是顺手带出来的：terms.md 说的是「除非该来源被明确登记为
  // 允许站内展示全文」，所以包里的 true 与登记表 industry/sources-fulltext.json 必须一一对应——
  // 多一个 true 没有依据、或少一条登记，都在这里判红。（2026-10-16 之前这一条写的是"包里不许有 true"，
  // 那钉的是当时的观察值 44 条源恰好都没开，不是承诺本身；正文上线后它挡不住真问题，只会挡住建功能。）
  const REGISTRY = (JSON.parse(readFileSync(new URL("../industry/sources-fulltext.json", import.meta.url), "utf8")) as
  { sources: Array<{ id: string; basis?: string }> }).sources;
  const licensed = new Set(PACK.filter((s) => s.site_fulltext === true).map((s) => s.id));
  const registered = new Set(REGISTRY.map((s) => s.id));
  assert.equal(licensed.size, registered.size, `站内全文的门（${licensed.size}）与登记表（${registered.size}）条数不等`);
  for (const id of licensed) assert.ok(registered.has(id), `${id} 在包里被开了站内全文，却没有登记依据`);
  for (const id of registered) assert.ok(licensed.has(id), `${id} 登记了依据，包里却是关的——把决定重做一遍再删登记`);
  for (const r of REGISTRY) assert.ok((r.basis ?? "").trim().length > 0, `${r.id} 的登记必须有 basis`);
  // 对外再分发（RSS/API 内联全文）比站内展示更重，仍然一道门都没开。
  for (const source of PACK) {
    assert.notEqual(source.syndicate_fulltext, true, `${source.id} is licensed for 对外全文`);
  }
});

test("every config template the new-source form offers is one the collector of that kind implements", () => {
  const templates = formTemplates();
  // Every kind the admin UI lets an editor pick must ship a template, or the config box shows the previous
  // kind's keys — the class of defect that put the wrong default key in the 公众号 template.
  for (const kind of Object.keys(KIND_LABEL)) {
    assert.ok(templates[kind], `${kind} is offered in the admin UI but has no config template`);
    assert.ok(Object.keys(templates[kind]!).length > 0 || kind === "external", `${kind} template is not empty`);
  }
  for (const [kind, keys] of Object.entries(templates)) {
    const config = Object.fromEntries(keys.map((k) => [k, k.startsWith("allow") || k.endsWith("Paths") ? [] : "x"]));
    assert.deepEqual(unsupportedConfig(kind as SourceRow["kind"], config), [], `${kind} template keys are all implemented by its collector`);
    assert.doesNotThrow(() => assertSupportedConfig(kind as SourceRow["kind"], config), `${kind} template is accepted on create`);
  }
  // The kinds this site actually registers must all be offered too.
  for (const kind of new Set(PACK.map((s) => s.kind))) {
    assert.ok(Object.hasOwn(KIND_LABEL, kind), `industry/sources.json registers kind ${kind}, which the admin UI does not name`);
  }
  assert.ok(templates.mp_account!.includes("ghid"), "the 公众号 template keys on ghid");
  assert.equal(templates.mp_account!.includes("username"), false, "and not on a key no collector reads");
});
