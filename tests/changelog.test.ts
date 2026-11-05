// The changelog is a hand-edited JSON file read lazily at request time (site/meta.ts), so a typo in it
// is caught by neither typecheck nor build — it surfaces as a 503 on /changelog, after a deploy. That
// happened on 2026-10-03: an ASCII straight quote inside the Chinese body text (出现"分类不在词表里"的行,
// written with " instead of 「」) made the file invalid, and verify-deploy's smoke found /changelog 503.
// This file pins the parse, plus the two conventions the readers rely on: newest first, and
// latestVersion = the newest date + time (the shell's red dot reads it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = () =>
  JSON.parse(readFileSync(new URL("../industry/changelog.json", import.meta.url), "utf8")) as {
    latestVersion: string;
    releases: Array<{ date: string; time: string; kind: string; title: string; body: string[] }>;
  };

test("changelog.json parses and keeps its two conventions", () => {
  const { latestVersion, releases } = read();
  assert.ok(releases.length > 0, "至少一条发布记录");
  const sorted = [...releases].sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
  assert.deepEqual(releases, sorted, "releases 新在前（读者从头读，壳里的红点看第一条）");
  const newest = releases[0]!;
  assert.equal(latestVersion, `${newest.date}T${newest.time}`, "latestVersion 是第一条的日期+时间");
  for (const r of releases) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, "日期形状");
    assert.match(r.time, /^\d{2}:\d{2}$/, "时间形状");
    assert.ok(r.title.trim(), `${r.date} ${r.time} 有标题`);
    assert.ok(Array.isArray(r.body) && r.body.length > 0 && r.body.every((l) => l.trim()), `${r.date} ${r.time} 的 body 每行非空`);
  }
});

// 2026-11-05 站长：「更新日志的文字都太多了，精简一些」——参考 AIHOT 那种一两条短句的密度。
// 这条守卫只钉形状（标题一句、正文一至三行、每行不超 80 字），不钉内容。
test("changelog entries stay short enough to scan", () => {
  const { releases } = read();
  for (const r of releases) {
    assert.ok(r.title.trim().length <= 22, `${r.date} ${r.time} 的标题太长：${r.title}`);
    assert.ok(r.body.length <= 3, `${r.date} ${r.time} 的正文超过三行`);
    for (const line of r.body) {
      assert.ok(line.trim().length <= 80, `${r.date} ${r.time} 有一行太长：${line.slice(0, 30)}…`);
    }
  }
});
