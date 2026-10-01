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
  // The 44 sources the pack registers are the policy in practice: none arrives licensed for full text.
  for (const source of PACK) {
    assert.notEqual(source.site_fulltext, true, `${source.id} is licensed for 站内全文`);
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
