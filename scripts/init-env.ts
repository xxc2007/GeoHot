// Creates .env and .env.pipeline from their .example templates, filling real random values into the
// secret keys, and prints the generated admin password once. Refuses to overwrite either file.
//
//   npm run env:init                                   # defaults: 5433 db / 3001 api / 3000 web / 3055 stub
//   npm run env:init -- --db-port 5455 --api-port 3299 --web-port 3090 --brain-port 3065
//
// Why this exists: .env and .env.pipeline are gitignored, so a clean clone has neither, and every
// documented start command (`node --env-file=.env …`) then dies with `.env: not found` (exit 9).
// The port flags are what let a second person run this stack beside a running one — see README §3.2.
//
// Precedence for each port: `--x-port=N` / `--x-port N` flag > shell env (DEV_DB_PORT / API_PORT /
// WEB_PORT / BRAIN_PORT) > the defaults written in .env.example. Secrets are never reused from the
// template: the four blank keys must be random in anything but a throwaway checkout.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const at = (file: string) => path.join(ROOT, file);

/** `--flag=value` or `--flag value`, falling back to the named environment variable. */
function readPort(flag: string, envKey: string): number | null {
  const inline = process.argv.find((a) => a.startsWith(`--${flag}=`));
  const index = process.argv.indexOf(`--${flag}`);
  const raw = inline ? inline.slice(`--${flag}=`.length) : index > -1 ? process.argv[index + 1] : process.env[envKey];
  if (raw === undefined || raw === "") return null;
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`env:init: --${flag} must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return port;
}

const ports = {
  db: readPort("db-port", "DEV_DB_PORT"),
  api: readPort("api-port", "API_PORT"),
  web: readPort("web-port", "WEB_PORT"),
  brain: readPort("brain-port", "BRAIN_PORT"),
};

const targets = [".env", ".env.pipeline"];
const alreadyThere = targets.filter((file) => existsSync(at(file)));
if (alreadyThere.length) {
  console.error(`env:init: ${alreadyThere.join(" 和 ")} 已经存在，没有覆盖。要重新生成，先把它们改名或删掉。`);
  process.exit(1);
}
for (const file of targets) {
  if (!existsSync(at(`${file}.example`))) {
    console.error(`env:init: 缺少模板 ${file}.example —— 这份仓库不完整。`);
    process.exit(1);
  }
}

/** Rewrite one `KEY=` line (uncommenting it when needed), appending it when the template has no such key. */
function setLine(text: string, key: string, value: string): string {
  if (new RegExp(`^# ?${key}=`, "m").test(text)) return text.replace(new RegExp(`^# ?${key}=.*$`, "m"), `${key}=${value}`);
  if (new RegExp(`^${key}=`, "m").test(text)) return text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
  return `${text.trimEnd()}\n${key}=${value}\n`;
}

const password = randomBytes(12).toString("base64url"); // 16 chars, over the 12-char floor in admin/auth.ts
const secret = () => randomBytes(32).toString("hex");

let env = readFileSync(at(".env.example"), "utf8")
  // Blank in the template on purpose: these four must be random, never copied values.
  .replace(/^ADMIN_PASSWORD=$/m, `ADMIN_PASSWORD=${password}`)
  .replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${secret()}`)
  .replace(/^IMG_PROXY_SIGN_SECRET=$/m, `IMG_PROXY_SIGN_SECRET=${secret()}`)
  .replace(/^POSTGRES_PASSWORD=$/m, `POSTGRES_PASSWORD=${randomBytes(18).toString("hex")}`)
  // Empty in the template means "ingest stays 401"; a real token makes POST /api/ingest/items usable.
  .replace(/^INGEST_TOKEN=$/m, `INGEST_TOKEN=${randomBytes(24).toString("hex")}`);

if (ports.db) env = env.replace(/^(DATABASE_URL=postgres:\/\/[^\s@]+@[\d.]+:)\d+(\/\S*)$/m, `$1${ports.db}$2`);
if (ports.web) {
  env = setLine(env, "WEB_PORT", String(ports.web));
  env = setLine(env, "SITE_URL", `http://localhost:${ports.web}`);
}
if (ports.api) {
  env = setLine(env, "API_PORT", String(ports.api));
  env = setLine(env, "API_BASE_URL", `http://127.0.0.1:${ports.api}`);
}
if (ports.brain) {
  env = setLine(env, "BRAIN_PORT", String(ports.brain));
  env = setLine(env, "LLM_BASE_URL", `http://127.0.0.1:${ports.brain}/v1`);
}

// The one-time pipeline layer carries the same model/stub pointer, so keep it consistent with .env.
let pipeline = readFileSync(at(".env.pipeline.example"), "utf8");
if (ports.brain) pipeline = setLine(pipeline, "LLM_BASE_URL", `http://127.0.0.1:${ports.brain}/v1`);

writeFileSync(at(".env"), env, { mode: 0o600 });
writeFileSync(at(".env.pipeline"), pipeline, { mode: 0o600 });

const shown = Object.entries(ports).filter(([, v]) => v !== null);
console.log(`已生成 .env 与 .env.pipeline（权限按 600 申请——Windows 上这个位只是名义的，别把仓库放进共享目录；两者都已被 .gitignore 排除）。`);
console.log(shown.length ? `端口：${shown.map(([k, v]) => `${k}=${v}`).join("  ")}` : `端口：全部用 .env 里的默认值（db 5433 / api 3001 / web 3000 / stub 3055）。`);
console.log(`管理员密码：${password}`);
console.log(`  —— 也写在 .env 的 ADMIN_PASSWORD 里。浏览器打开 ${ports.web ? `http://localhost:${ports.web}` : "http://localhost:3000"}/admin/login，用户名不需要，只输这个密码。`);
console.log("随机生成并已写入的密钥：SESSION_SECRET、IMG_PROXY_SIGN_SECRET、POSTGRES_PASSWORD、INGEST_TOKEN。");
console.log("下一步：npm run db:up -- --daemon" + (ports.db ? ` --port=${ports.db}` : ""));
