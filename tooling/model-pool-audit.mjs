#!/usr/bin/env node
// 模型池体检：拿 magpie 的 /v1/models 对着我们的模型池逐条核对，把已经不存在的成员标出来。
//
// 为什么需要它：2026-11-16 的现场，池首 `loomy-deepseek-v41-flash` 一小时被叫了 164 次，
// 而池里同时躺着 `qwenwork/pro`、`minimax-code/MiniMax-M3.1-Flash`、`codearts/…-1017`、
// `auto-hy3` 这些 magpie 早已不认的成员——每一次命中都是一次 404 往返，还挤掉了真正
// 能用的模型。模型池是手写的 env 列表，没有人会在删 magpie 账号时同步删它。
//
// 用法：
//   node tooling/model-pool-audit.mjs --models models.json [--env /opt/geohot/app/.env]
//        [--registry packages/backend/src/providers/llm.ts] [--write] [--json]
//   --write 会把查无此模型的成员从 *_MODEL(S) 里删掉（每行至少留一个），并把原文件备份成 .bak-pool-<时间>
//
// 判据：别名 → 注册表里的 magpie id（`service/model`）；magpie 的列表里没有这个 id（也不认
// 去掉 service 前缀的写法）就算失效。magpie 报 404 时用的 `group/<别名>` 形态也一并认。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const registryPath = arg("registry", "packages/backend/src/providers/llm.ts");
const modelsPath = arg("models");
const envPath = arg("env");
if (!modelsPath) {
  console.error("用法：node tooling/model-pool-audit.mjs --models <magpie models.json> [--env <env 文件>] [--write]");
  process.exit(2);
}

/** 从注册表里刨出 别名 → magpie id。格式固定：`"alias": {` 后跟 `key:"alias",service:"x",model:"y"`。 */
function readRegistry(text) {
  const map = new Map();
  const re = /"([^"]+)":\s*\{\s*key:\s*"[^"]+",\s*service:\s*"([^"]+)",\s*model:\s*"([^"]+)"/g;
  for (const m of text.matchAll(re)) map.set(m[1], { service: m[2], model: m[3] });
  return map;
}

function readMagpie(text) {
  const json = JSON.parse(text);
  const list = json.data ?? json.models ?? [];
  // 小写归一：magpie 的 `auto/DeepSeek-V4.1-Flash` 与 `auto/deepseek-v4.1-flash` 是同一个模型
  // （2026-11-16 用 1-token 探针实测两者都 200），按大小写敏感比对会把它误判成失效。
  return new Set(list.map((m) => String(m.id ?? m.name ?? "").toLowerCase()).filter(Boolean));
}

/** 探针实测已经 404 的别名（magpie 那边确实没有这个模型），比列表推断更硬。 */
function readForced(path) {
  if (!path) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#")),
  );
}
const forced = readForced(arg("dead"));

const registry = readRegistry(readFileSync(registryPath, "utf8"));
const magpie = readMagpie(readFileSync(modelsPath, "utf8"));

/** 别名在 magpie 那边还算不算数。
 *
 * 只有 `--dead` 清单（探针实测 404）算数：`/v1/models` 的列表既缺别名也缺 magpie 能吃下的
 * 裸 id（`hy3` 就是 200），拿它对表会造出一堆假死。列表只用来提示「清单里查不到」。
 */
export function aliasAlive(alias, forcedDead = forced) {
  // 只有探针实测 404 的清单算数：注册表正则认不出的写法、magpie 能吃下的裸 id，
  // 都不能当「已失效」——那会造出假死，还会把能用的成员从池子里删掉。
  return !forcedDead.has(alias);
}

/** 仅供参考：注册表里的 id 在 /v1/models 里查不到（可能是别名/裸 id，也可能是真没了）。 */
export function suspect(alias) {
  const spec = registry.get(alias);
  if (!spec) return false;
  const candidates = [spec.model, `${spec.service}/${alias}`, alias];
  return !candidates.some((c) => magpie.has(c.toLowerCase()));
}

function auditEnv(text) {
  const lines = text.split("\n");
  const report = [];
  const pruned = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^([A-Z0-9_]*MODELS?)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    const members = value.split(",").map((s) => s.trim()).filter(Boolean);
    const dead = members.filter((a) => !aliasAlive(a));
    const soft = members.filter((a) => !dead.includes(a) && suspect(a));
    report.push({ key, total: members.length, dead, soft });
    if (dead.length === 0) continue;
    const kept = members.filter((a) => aliasAlive(a));
    if (kept.length === 0) {
      report[report.length - 1].keptAll = true;
      continue;
    }
    pruned.push(key);
    lines[i] = `${key}=${kept.join(",")}`;
  }
  return { report, pruned, text: lines.join("\n") };
}

const only = arg("alias");
if (only) {
  console.log(`${only}: ${aliasAlive(only) ? "alive" : "dead"}${registry.get(only) ? ` (${registry.get(only).model})` : " (注册表里没有这个别名)"}`);
  process.exit(0);
}

if (!envPath) {
  console.log(`magpie 认得 ${magpie.size} 个模型，注册表 ${registry.size} 个别名`);
  process.exit(0);
}

const original = readFileSync(envPath, "utf8");
const { report, pruned, text } = auditEnv(original);
const deadAll = [...new Set(report.flatMap((r) => r.dead))];

if (has("json")) {
  console.log(JSON.stringify({ magpie: magpie.size, registry: registry.size, report, pruned, deadAll }, null, 2));
} else {
  console.log(`magpie ${magpie.size} 个模型 · 注册表 ${registry.size} 个别名 · 失效成员 ${deadAll.length} 个`);
  for (const r of report) {
    const tail = r.keptAll ? "（全失效，保留原样）" : "";
    console.log(`  ${r.key}: ${r.total} 个成员，失效 ${r.dead.length} ${r.dead.join(" ") || "—"}${tail}`);
  }
  if (deadAll.length) console.log(`失效清单：${deadAll.join(" ")}`);
}

if (has("write") && pruned.length) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  copyFileSync(envPath, `${envPath}.bak-pool-${stamp}`);
  writeFileSync(envPath, text);
  console.log(`已重写 ${pruned.join(" ")}，备份 ${envPath}.bak-pool-${stamp}`);
}
