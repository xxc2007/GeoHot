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
 * 无重大更新标记时整体按 1.0.x 编号兜底。
 */
export function withVersionNumbers(data: { latestVersion: string; releases: ChangelogRelease[] }) {
  const total = data.releases.length;
  const majorIdx = data.releases.findIndex((r) => r.major);
  const releases = data.releases.map((r, i) => ({
    ...r,
    version: majorIdx < 0 ? `1.0.${total - 1 - i}` : i === majorIdx ? "2.0.0" : i < majorIdx ? `2.0.${majorIdx - i}` : `1.0.${total - 1 - i}`,
  }));
  return { latestVersion: data.latestVersion, releases };
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
