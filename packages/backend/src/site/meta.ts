// Small site-wide facts for the web shell (e.g. the changelog red-dot anchor).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";

export interface ChangelogRelease {
  date: string;
  time: string;
  kind: "更新" | "优化" | "公告" | "下线" | "修复";
  title: string;
  body: string[];
  major?: boolean;
  /** 按发布顺序编号的站点版本：2.0.0 = 2026-10-24 重大更新，此后逐版递增；此前从 1.0.0 起算。 */
  version?: string;
}

/**
 * 版本号由发布顺序唯一决定，不写进 changelog.json——同一份历史无论何时重算，结果都一致。
 * releases 最新在前（i 越小越新）。时间从旧到新扫一遍，每个 major 条目开启一个大版本：
 * 第一个里程碑是 2.0.0，之后每个新里程碑主版本加一（3.0.0、4.0.0……）。
 * 一个时代 = 里程碑 + 比它新、直到下一个里程碑之前的所有条目；时代内修订号按时间先后
 * 递增（里程碑 0，它下一条 1，再下一条 2……最新一条最大）。首个里程碑之前的条目从
 * 1.0.0（最旧）按时间先后递增。
 */
export function withVersionNumbers(data: { latestVersion: string; releases: ChangelogRelease[] }) {
  const total = data.releases.length;
  const versions = new Array<string>(total).fill("1.0.0");
  // 时间升序遍历：i 从 total-1（最旧）到 0（最新）
  let era = 1; // 里程碑前是 1.x；每遇一个里程碑 +1（第一个里程碑 → 2.0.0）
  let patch = -1; // 当前时代内已编号的条目数
  for (let i = total - 1; i >= 0; i--) {
    if (data.releases[i]?.major) {
      era += 1;
      patch = 0;
    } else {
      patch += 1;
    }
    versions[i] = `${era}.0.${patch}`;
  }
  return { latestVersion: data.latestVersion, releases: data.releases.map((r, i) => ({ ...r, version: versions[i] })) };
}

let changelogCache: { mtimeMs: number; data: { latestVersion: string; releases: ChangelogRelease[] } } | null = null;

/**
 * Changelog is published as a data file in the industry pack (industry/changelog.json), newest first.
 * Re-read when the file changes, like the rest of `industry/**`: a once-per-process cache meant that
 * shipping an entry needed a service restart, and `deploy/geohot/DEPLOYMENT.md` says the opposite for
 * this directory (measured 2026-10-06 — the file on disk had 13:40, the API still served 12:35).
 */
export function loadChangelog() {
  const file = process.env.AIHOT_CHANGELOG_FILE || path.join(REPO_ROOT, "industry/changelog.json");
  const { mtimeMs } = statSync(file);
  if (!changelogCache || changelogCache.mtimeMs !== mtimeMs) {
    changelogCache = { mtimeMs, data: JSON.parse(readFileSync(file, "utf8")) as { latestVersion: string; releases: ChangelogRelease[] } };
  }
  return changelogCache.data;
}

export function siteMeta() {
  return { changelogVersion: loadChangelog().latestVersion };
}
