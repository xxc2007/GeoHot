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
    // 月报的窗口是**整个自然月**，28—31 天不等，所以宽限期不能取这一期自己的长度：
    // 8 月有 31 天，取自己的长度会让它在 10 月 1 日仍写着「本月看点」——那时读者的本月是 10 月，
    // 而 9 月那期已经在 10 月 1 日 00:00 合上窗口了。这一族边界（31 天月接 30 天月）以前一条都没测过。
    assert.equal(word("monthly", "2026-08-01T00:00:00+08:00", "2026-09-01T00:00:00+08:00", Date.parse("2026-10-01T12:00:00+08:00")), "本期",
      "八月那期在十月一日中午不能再自称「本月」");
    assert.equal(word("monthly", "2026-07-01T00:00:00+08:00", "2026-08-01T00:00:00+08:00", Date.parse("2026-09-01T00:30:00+08:00")), "本期");
    // 取短是安全方向：2 月只有 28 天，它会在 3 月 29—31 日提前退回「本期」，而那时它仍是最新一期。
    // 少说一次「本月」不是假话，多说一次才是——所以这条钉的是方向，不是"永远当令"。
    assert.equal(word("monthly", "2026-02-01T00:00:00+08:00", "2026-03-01T00:00:00+08:00", Date.parse("2026-03-29T10:00:00+08:00")), "本期");
    assert.equal(word("monthly", "2026-02-01T00:00:00+08:00", "2026-03-01T00:00:00+08:00", Date.parse("2026-03-20T10:00:00+08:00")), "本月");
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

test("周报的历史区块把补刊出来的每一期都列出来，日报仍走整页归档", async () => {
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, ".."),
    server: { middlewareMode: true }, appType: "custom" });
  try {
    const module = await server.ssrLoadModule("/app/features/report/ReportPaper.tsx");
    const Paper = module.ReportPaper as ComponentType<{ report: ReportDetail; index: ReportNavigationEntry[]; now: number }>;
    const cited: ReportCitation = { itemId: "hist-item", title: "被引用的那条动态", summary: "供历史区块渲染的摘要",
      sourceName: "官方来源", sourceUrl: "https://example.org/o", sourceId: null, sourceIconUrl: null,
      firstParty: false, role: null, storyPublicId: null, publishedAt: "2026-01-06T02:00:00Z", available: true, hasPage: true };
    // 回填之后阅读侧的周报会有约 40 期：这一格是手机上唯一的"更早"入口，截断就等于藏起来。
    const weeks: ReportNavigationEntry[] = Array.from({ length: 20 }, (_, i) => ({ key: `2100-W${String(i + 1).padStart(2, "0")}` }));
    const render = (kind: "daily" | "weekly", key: string, index: ReportNavigationEntry[]) => {
      const report: ReportDetail = { kind, key, title: "报名",
        windowStart: "2026-01-05T00:00:00+08:00", windowEnd: "2026-01-12T00:00:00+08:00",
        generatedAt: "2026-10-12T00:00:00Z", revision: 1, readable: true, lead: null, overview: null,
        highlights: [cited], sections: [{ label: "自然与资源", summary: null, items: [cited] }],
        stories: [{ ...cited, label: "自然与资源" }], flashes: [], cover: null, metrics: {},
        readingMinutes: 1, prev: null, next: null };
      return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(Paper, { report, index, now: Date.now() })));
    };
    const section = (html: string) => html.slice(html.indexOf('id="report-history"'));
    const weekly = section(render("weekly", "2100-W01", weeks));
    const listed = new Set(weekly.match(/\/weekly\/2100-W\d\d/g) ?? []);
    assert.equal(listed.size, weeks.length - 1, `周报历史区块只列了 ${listed.size} 期，应为除当期外的 ${weeks.length - 1} 期`);
    // 日报有 `/daily/archive` 那一整页，报面这一格保持有界，但被截掉的那部分要说出来并给出出口。
    const days: ReportNavigationEntry[] = Array.from({ length: 30 }, (_, i) => ({ key: `2100-04-${String(i + 1).padStart(2, "0")}` }));
    // 日报不渲染这一格（`hasHistory` 只对周报月报为真）：它有 `/daily/archive` 那一整页，
    // 页脚那条「日报合订本」就是出口。这里钉住这个分工，免得以后给日报再加一个有界的重复列表。
    const dailyHtml = render("daily", "2100-04-01", days);
    assert.ok(!dailyHtml.includes('id="report-history"'), "日报页不该再有一份页内往期清单");
    assert.match(dailyHtml, /href="[^"]*daily\/archive"/, "日报页脚要留着通往完整归档的那条出口");
  } finally { await server.close(); }
});
