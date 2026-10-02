// Guards the README figures: every file must be referenced, no two may be the same picture, and a
// `-dark` figure must actually be dark.
//
// Why this exists: `--force-prefers-color-scheme=dark` silently does nothing on this site's headless
// Chrome runs, so four `docs/shots/*-dark.png` shipped as light-theme screenshots under a dark name —
// and one of them (topics-dark) was a byte-copy of its light twin. Both mistakes passed every gate that
// existed, because a PNG signature check cannot tell a lie from a mistake. Run it in CI and before any
// publish: node scripts/check-shots.ts
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHOTS = path.join(ROOT, "docs", "shots");
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");

/** Decodes a non-interlaced 8-bit PNG and returns its mean luminance. */
function luminance(file: string) {
  const buf = readFileSync(file);
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { error: "不是 PNG" };
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) return { error: `depth=${depth} interlace=${interlace}（本脚本只处理非隔行的 8 位图）` };
  const ch = color === 6 ? 4 : color === 2 ? 3 : color === 0 ? 1 : 0;
  if (!ch) return { error: `色彩类型 ${color} 不支持` };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  let prev = Buffer.alloc(stride);
  let sum = 0;
  for (let y = 0; y < h; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) sum += 0.2126 * line[x * ch] + 0.7152 * line[x * ch + 1] + 0.0722 * line[x * ch + 2];
    prev = line;
  }
  return { mean: sum / (w * h), w, h };
}

const files = readdirSync(SHOTS).filter((f) => f.endsWith(".png")).sort();
const failures: string[] = [];
const hashes = new Map<string, string>();

for (const f of files) {
  const rel = `docs/shots/${f}`;
  if (!README.includes(rel)) failures.push(`${rel}：README 里没有一处引用它。要么介绍页用得上（那就写进去），要么它是过程产物（那就删掉）——留着不用的一张图，下一次改版就没人记得它还准不准。`);
  const stat = luminance(path.join(SHOTS, f));
  if (stat.error) { failures.push(`${rel}：${stat.error}`); continue; }
  const digest = crypto.createHash("sha256").update(readFileSync(path.join(SHOTS, f))).digest("hex").slice(0, 12);
  const twin = hashes.get(digest);
  if (twin) failures.push(`${rel} 与 ${twin} 逐字节相同：同一张图不可能既是亮色又是暗色。`);
  else hashes.set(digest, rel);
  const isDark = /-dark\./.test(f);
  if (isDark && stat.mean! > 90) failures.push(`${rel}：命名为 dark，但整幅平均亮度 ${stat.mean!.toFixed(1)}（>90）——它其实是亮色截图。无头 Chrome 的 --force-prefers-color-scheme 不会改变本站主题，暗色图必须真的点一次主题开关。`);
  if (!isDark && stat.mean! < 90) failures.push(`${rel}：命名为 light，平均亮度 ${stat.mean!.toFixed(1)}（<90）——名字和内容不符。`);
  console.log(`${rel.padEnd(26)} ${stat.w}x${stat.h}  平均亮度 ${stat.mean!.toFixed(1)}`);
}

if (!files.length) failures.push("docs/shots 里没有图：介绍页的截图必须与实际网站一致，不能没有。");

if (failures.length) {
  console.error(`\n✗ 配图检查未通过（${failures.length} 项）：`);
  for (const m of failures) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`\n✓ ${files.length} 张配图：全部被 README 引用、无重复、明暗与命名一致。`);
