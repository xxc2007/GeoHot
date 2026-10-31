import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer } from "vite";
import type { ReportCitation, ReportDetail, ReportNavigationEntry } from "@aihot/contracts/site";

test("report headings and flashes always navigate: itemId to the item page, else the original", async () => {
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, ".."),
    server: { middlewareMode: true }, appType: "custom" });
  try {
    const module = await server.ssrLoadModule("/app/features/report/ReportPaper.tsx");
    const Paper = module.ReportPaper as ComponentType<{ report: ReportDetail; index: ReportNavigationEntry[]; now: number }>;
    const citation: ReportCitation = { itemId: "absent-citation", title: "历史引注标题", summary: "历史资料原文摘要",
      sourceName: "官方来源", sourceUrl: "https://example.org/original", sourceId: null, sourceIconUrl: null,
      firstParty: true, role: null, storyPublicId: null, publishedAt: null, available: true, hasPage: false };
    const render = (c: ReportCitation) => {
      const report: ReportDetail = { kind: "daily", key: "2026-01-01", title: "地理日报",
        windowStart: "2026-01-01T00:00:00+08:00", windowEnd: "2026-01-02T00:00:00+08:00",
        generatedAt: "2026-01-02T01:00:00Z", revision: 1, readable: true, lead: null, overview: null,
        highlights: [c], sections: [{ label: "自然地理", summary: null, items: [c] }],
        stories: [{ ...c, label: "自然地理" }], flashes: [{ ...c, itemId: "flash-citation" }],
        cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null };
      return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(Paper, {
        report, index: [{ key: report.key, no: 1 }], now: Date.now(),
      })));
    };
    // 2026-10-31: hasPage no longer gates the title link — navigation and the read gate are
    // separate. A citation with an itemId navigates to its item page even when the page is not
    // fully readable there; only a citation with no itemId at all falls back to the original.
    const missing = render(citation);
    assert.ok(missing.includes("/items/absent-citation"), "hasPage=false still navigates to the item page");
    assert.ok(missing.includes("/items/flash-citation"));
    const pageless = render({ ...citation, itemId: null });
    assert.ok(pageless.includes('href="https://example.org/original"'), "no itemId falls back to the original");
    const unlinked = render({ ...citation, itemId: null, sourceUrl: "" });
    assert.ok(!unlinked.includes('href=""'));
    assert.ok(unlinked.includes(citation.title));
  } finally { await server.close(); }
});
