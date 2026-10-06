// One rule for the boolean safety valves (AGENTS.md: 开发和测试时保持安全阀关闭). The same variable name used
// to be read three ways — `!== "false"` in the worker and the alerts, `bool()` in config.ts, `=== "true"` in
// the Feishu notifier — so `COLLECT_ENABLED=0` left the worker poking 85 upstream sources every minute while
// the rest of the process believed collection was off. These tests pin the table for `envFlag`/`isCollectEnabled`
// and keep the read points from re-forking.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { envFlag, isCollectEnabled, isModelCallsEnabled, positiveInt, REPO_ROOT } from "@aihot/backend/config";

const NAME = "VALVE_TABLE_PROBE";
const savedValue = process.env[NAME];
after(() => {
  if (savedValue === undefined) delete process.env[NAME];
  else process.env[NAME] = savedValue;
});

/** Everything that must mean off, whatever the fallback is. */
const OFF = ["0", "false", "FALSE", "False", "fAlSe", "off", "no", "n", "2", "yes", "true1", " ", "tr ue"];
/** Everything that must mean on. */
const ON = ["1", "true", "TRUE", "True"];

/** Every TS/TSX file the shipped code is made of (both repo-wide guards below walk the same tree). */
function sourceFiles(): string[] {
  const roots = ["packages", "apps", "industry", "scripts", "tooling"].map((d) => path.join(REPO_ROOT, d));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  for (const root of roots) if (statSync(root).isDirectory()) walk(root);
  return files;
}
/** A file's code without its line comments: a comment may name a valve or a knob without reading it. */
const code = (file: string) => readFileSync(file, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");

test("envFlag: 0 / false / off and any other non-empty spelling are off; only 1 and true are on", () => {
  for (const value of OFF) {
    process.env[NAME] = value;
    assert.equal(envFlag(NAME, true), false, `${JSON.stringify(value)} with fallback true must read as off`);
    assert.equal(envFlag(NAME, false), false, `${JSON.stringify(value)} with fallback false must read as off`);
  }
  for (const value of ON) {
    process.env[NAME] = value;
    assert.equal(envFlag(NAME, false), true, `${JSON.stringify(value)} must read as on`);
    assert.equal(envFlag(NAME, true), true, `${JSON.stringify(value)} must read as on`);
  }
});

test("envFlag: an empty value is the caller's fallback, never a silent on", () => {
  process.env[NAME] = "";
  assert.equal(envFlag(NAME, true), true, "an empty value is not a value: a valve that defaults open stays open");
  assert.equal(envFlag(NAME, false), false, "…and one that defaults closed stays closed");
  delete process.env[NAME];
  assert.equal(envFlag(NAME, true), true, "a missing variable is the same as an empty one");
  assert.equal(envFlag(NAME, false), false, "…and never reads as on by accident");
});

test("COLLECT_ENABLED and MODEL_CALLS_ENABLED read through that one rule", () => {
  for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED"] as const) {
    const read = name === "COLLECT_ENABLED" ? isCollectEnabled : isModelCallsEnabled;
    const saved = process.env[name];
    try {
      for (const value of ["0", "false", "FALSE", "off"]) {
        process.env[name] = value;
        assert.equal(read(), false, `${name}=${value} must stop the pipeline reaching out`);
      }
      for (const value of ["1", "true", "TRUE"]) {
        process.env[name] = value;
        assert.equal(read(), true, `${name}=${value} is the deployment asking for it`);
      }
      process.env[name] = "";
      assert.equal(read(), true, `${name}= falls back to the documented default (on unless written down)`);
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  }
});

test("development stays closed by what is shipped, not by a default", () => {
  // The defaults above are on, so a clean clone is only safe because the template writes the valves down.
  const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    assert.match(example, new RegExp(`^${name}=false$`, "m"), `.env.example must ship ${name}=false`);
    assert.equal(envFlag(name, false), false, `${name} must not be switched on here (tests inherit .env)`);
  }
});

test("no second reading of COLLECT_ENABLED survives outside config.ts", () => {
  const readers = sourceFiles().filter((file) => {
    if (file.endsWith(path.join("src", "config.ts"))) return false;
    // Only a read counts: `envFlag("COLLECT_ENABLED", …)` lives in config.ts, and comments may name the valve.
    return /process\.env\.COLLECT_ENABLED|env\["COLLECT_ENABLED"\]|"COLLECT_ENABLED"|\bCOLLECT_ENABLED\b\s*[!=]==/.test(code(file));
  });
  assert.deepEqual(readers.map((f) => path.relative(REPO_ROOT, f)), [], "read the valve through isCollectEnabled(), never by hand");
});

test("positiveInt: a configured number is either a positive whole number or the default", () => {
  // 缺省与"没填"是同一条路，静默走默认；填了但用不上才说话。
  assert.equal(positiveInt(undefined, "K", 40), 40);
  assert.equal(positiveInt("", "K", 40), 40, "an empty value is not a value");
  for (const bad of ["two", "3O", "0", "-3", "auto", "NaN", " ", [], {}, true, false, Number.NaN, Infinity]) {
    assert.equal(positiveInt(bad, "K", 40), 40, `${JSON.stringify(bad)} 不能当并发数/上限用：那正是 NaN 让守卫恒假的那一类`);
  }
  assert.equal(positiveInt("1", "K", 40), 1, "1 is legal（FETCH_SCHEDULE_BATCH=1 是文档里的减速档）");
  assert.equal(positiveInt("8", "K", 40), 8);
  assert.equal(positiveInt(2.7, "K", 40), 2, "一个带小数的并发数取整，而不是把 2.7 交给 pg-boss");
});

test("no second implementation of the configured-number rule survives", () => {
  // `Number(process.env.X || default)` is the shape that turns a typo into NaN and then into a silent
  // behaviour change (a NaN `localConcurrency`, a NaN pool max, a NaN `slice(0, …)` that stored nothing
  // while reporting ok). Every tuning number now goes through config.positiveInt.
  // `apps/web/server.ts` is left out on purpose: the SSR server cannot read the backend's config (the
  // layering rule in AGENTS.md), and a bad WEB_PORT fails loudly at `listen`, which is the acceptable
  // behaviour for a boot-time knob it has to parse itself.
  const offenders = sourceFiles()
    .filter((file) => !file.endsWith(path.join("src", "config.ts")) && !file.startsWith(path.join(REPO_ROOT, "apps", "web")))
    .filter((file) => /Number\(\s*(?:process\.)?env\.[A-Za-z_0-9]+\s*\|\|/.test(code(file)))
    .map((f) => path.relative(REPO_ROOT, f));
  assert.deepEqual(offenders, [], "配置数字一律走 config.positiveInt，不要再各写一份");
});

test("故事 public id 的形状只写在 contracts/taxonomy.ts 一处", () => {
  // `UUID_PATTERN` 早就导出了，但读取层有三个文件各自手抄了同一条字面量（followups / groups / stories），
  // 与本轮在 `hasChineseCopy`、`positiveInt` 上收拾的是同一族问题：一条规则好几种写法，改一处漏两处。
  // 这条扫描把它钉成一处。`static.ts` 的 `-[0-9a-f]{8}\.` 是资源文件的内容哈希，不是 uuid 形状，不算抄写。
  const spellings = sourceFiles()
    .filter((file) => /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(code(file)))
    .map((f) => path.relative(REPO_ROOT, f));
  assert.deepEqual(spellings, [path.join("packages", "contracts", "src", "taxonomy.ts")], "uuid 的形状只在 UUID_PATTERN 写一次");
});

test("中文稿门槛的汉字区间只写在 contracts/copy.ts 一处", () => {
  // 与 `UUID_PATTERN`、`positiveInt` 同一族：一条规则好几种写法，改一处漏两处。这一条曾被抄成
  // 读取层的 SQL 正则、`detail.ts` 与 `translate.ts` 的正文判定、`writing.ts` 的三处计数、
  // web 的"还没有中文稿"提示和三个运维脚本——共六处手抄。
  // 区间用码位拼出来，免得这条断言自己成为第七处抄写。
  const HAN_CLASS = "[" + String.fromCharCode(0x4e00) + "-" + String.fromCharCode(0x9fff) + "]";
  const sites = sourceFiles()
    .filter((file) => code(file).includes(HAN_CLASS))
    .map((f) => path.relative(REPO_ROOT, f));
  assert.deepEqual(sites, [path.join("packages", "contracts", "src", "copy.ts")], "汉字区间只在 CJK_COPY_PATTERN 写一次");
});

test("「只有标签没有内容」那三条标签名，也只在 contracts/copy.ts 拼一次", () => {
  // The SQL column `title_zh` legitimately appears in several queries; the *alternation* is the rule
  // (`LABEL_ONLY_COPY` / `LABEL_PREFIX`), and it used to be hand-copied into `editorial/writing.ts`
  // while the read layer had no equivalent at all.
  const ALTERNATION = "title_zh|summary_zh|body_zh";
  const sites = sourceFiles()
    .filter((file) => code(file).includes(ALTERNATION))
    .map((f) => path.relative(REPO_ROOT, f));
  assert.deepEqual(sites, [path.join("packages", "contracts", "src", "copy.ts")], "标签规则只在 copy.ts 写一次");
});

test("SQL 模板串里没有 // 注释：那是发给数据库的文本，不是 TypeScript 的注释", () => {
  // 2026-10-06 我自己踩进去过一次（admin/feedback.ts 与 admin/sources.ts 的 ORDER BY 上方补解释时顺手写在
  // 模板串里）：`//` 在模板串里只是普通字符，会原样进 SQL；而如果注释里带反引号，还会**提前结束这个模板串**，
  // 于是一个本该被 tsc 拦住的写法，代价是 6 处语法错 + 13 个测试文件起不来。解释要写在语句上面，SQL 里要写
  // 就用 `--`。
  const SQLISH = /\b(?:sql|tx)(?:<[^>]*>)?`([\s\S]*?)`/g;
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(SQLISH)) {
      if (!/\b(SELECT|UPDATE|INSERT INTO|DELETE FROM)\b/i.test(match[1]!)) continue;
      scanned += 1;
      if (/^\s*\/\//m.test(match[1]!)) offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.ok(scanned > 400, `这条扫描要真的覆盖到 SQL 才算数：只认到 ${scanned} 个模板串`);
  assert.deepEqual(offenders, [], "// 注释不能在 SQL 模板串里");
});

