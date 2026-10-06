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
