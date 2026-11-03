// 三线检验与合并的配套工具：把 industry/changelog.json 的全部条目按发布顺序编号并输出
// 「v版本 → 发布时间 → 标题」清单，供 sync-version-tags Action 逐行打 tag / 建 Release。
// 纯文件读取 + 纯计算，无任何进程派生（与 packages/backend/src/site/meta.ts 的
// withVersionNumbers 同一算法，两边必须保持一致）。
import { readFileSync } from "node:fs";

const pack = JSON.parse(readFileSync("industry/changelog.json", "utf8"));
const total = pack.releases.length;
const versions = new Array(total).fill("1.0.0");
let era = 1;
let patch = -1;
for (let i = total - 1; i >= 0; i--) {
  if (pack.releases[i].major) {
    era += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  versions[i] = era + ".0." + patch;
}
const lines = [];
for (let i = 0; i < total; i++) {
  const r = pack.releases[i];
  const time = typeof r.time === "string" && r.time.length === 5 ? r.time : "00:00";
  const title = String(r.title).split("\t").join(" ").trim();
  lines.push("v" + versions[i] + "\t" + r.date + "T" + time + "\t" + title);
}
console.log(lines.join("\n"));
