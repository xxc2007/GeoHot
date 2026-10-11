// 历史期次不能让报面说"本周"。回填会补印 1—9 月的期次，而 `今日/本周/本月` 这三句话只对
// 读者手上那一份**还当令**的报纸成立：一份 1 月的周报在 10 月被打开时写着「本周看点」就是说谎，
// 与它自己的期号（`2026-W02`）矛盾。这里量两件事：判据本身，以及报头真的印出来的是哪三个字。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import type { ReportCitation, ReportDetail, ReportNavigationEntry } from "@aihot/contracts/site";

const DAY = 86_400_000;

test("periodWord 只对还当令的那一期说今日/本周/本月", async () => {
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, ".."),
    server: { middlewareMode: true }, appType: "custom" });
  try {
    const { periodWord } = await server.ssrLoadModule("/app/features/report/ReportPaper.tsx");
    const word = periodWord as (kind: "daily" | "weekly" | "monthly", start: string, end: string, now: number) => string;
    // 日报 D 覆盖 [D-1 08:00, D 08:00)：D 08:00 之后到 D+1 08:00 之前，它是"今日"；再往后就是历史。
    const open = "2026-10-10T08:00:00+08:00";
    const close = "2026-10-11T08:00:00+08:00";
    assert.equal(word("daily", open, close, Date.parse("2026-10-11T09:00:00+08:00")), "今日");
    // 下一期要到 D+1 的 08:00 才合上窗口，所以那之前"D 那一期"仍然是读者手上的当令报纸——
    // 凌晨六点打开昨天那份，报面写的还是「今日看点」，这句不是错话。
    assert.equal(word("daily", open, close, Date.parse("2026-10-12T07:00:00+08:00")), "今日");
    assert.equal(word("daily", open, close, Date.parse("2026-10-12T09:00:00+08:00")), "本期");
    assert.equal(word("daily", open, close, Date.parse("2026-10-11T07:00:00+08:00")), "本期", "窗口还没合上就是一份稿样");
    // 周报的窗口是整周，"本周"要撑到下一期该合上的时刻。
    const wOpen = "2026-01-05T00:00:00+08:00";
    const wClose = "2026-01-12T00:00:00+08:00";
    assert.equal(word("weekly", wOpen, wClose, Date.parse("2026-01-13T00:00:00+08:00")), "本周");
    assert.equal(word("weekly", wOpen, wClose, Date.parse("2026-10-12T08:00:00+08:00")), "本期");
    assert.equal(word("monthly", "2026-01-01T00:00:00+08:00", "2026-02-01T00:00:00+08:00", Date.parse("2026-10-12T08:00:00+08:00")), "本期");
    assert.equal(word("monthly", "2026-09-01T00:00:00+08:00", "2026-10-01T00:00:00+08:00", Date.parse("2026-10-05T08:00:00+08:00")), "本月");
    // 坏数据（缺窗口/非日期）不许抛，也不能蒙混成"本月"。
    assert.equal(word("daily", "", "not-a-date", Date.now()), "本期");
  } finally { await server.close(); }
});

test("一月的周报在十月打开，报头印的是「本期看点」", async () => {
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, ".."),
    server: { middlewareMode: true }, appType: "custom" });
  try {
    const module = await server.ssrLoadModule("/app/features/report/ReportPaper.tsx");
    const Paper = module.ReportPaper as ComponentType<{ report: ReportDetail; index: ReportNavigationEntry[]; now: number }>;
    const cited: ReportCitation = { itemId: "jan-item", title: "一月的一条入选动态", summary: "一月发生的地理事实摘要",
      sourceName: "官方来源", sourceUrl: "https://example.org/original", sourceId: null, sourceIconUrl: null,
      firstParty: true, role: null, storyPublicId: null, publishedAt: "2026-01-06T02:00:00Z", available: true, hasPage: true };
    const report: ReportDetail = { kind: "weekly", key: "2026-W02", title: "地理周报 · 2026-W02",
      windowStart: "2026-01-05T00:00:00+08:00", windowEnd: "2026-01-12T00:00:00+08:00",
      generatedAt: new Date(Date.now() - DAY).toISOString(), revision: 1, readable: true,
      lead: null, overview: "本期覆盖 2026-01-05 至 2026-01-11，共 1 条入选动态，分 1 个主题列出。",
      highlights: [cited], sections: [{ label: "一月的那件事", summary: "本主题 1 条（条目 1），按入选分数排列。", items: [cited] }],
      stories: [{ ...cited, label: "一月的那件事" }],
      flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null };
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(Paper, {
      report, index: [{ key: report.key, no: 1 }], now: Date.parse("2026-10-12T08:00:00+08:00"),
    })));
    assert.ok(html.includes("本期看点"), "报头没有改口成「本期看点」");
    assert.ok(!html.includes("本周看点"), "一月的报纸仍对读者说「本周」");
    assert.ok(!html.includes("今日看点"), "一月的报纸仍对读者说「今日」");
  } finally { await server.close(); }
});
