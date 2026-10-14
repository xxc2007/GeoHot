// months-mode within-month pagination for the news backfill (scripts/backfill-news.ts). Pure
// dependency injection like scripts/backfill-news.test.ts: the fetch/store/queue/checkpoint
// dependencies are stubbed, so nothing here touches the network or a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, type ArchiveRule, type Dependencies, type Options, type State } from "../scripts/backfill-news.ts";
import { FetchError, type Candidate, type SourceRow } from "../packages/backend/src/sources/types.ts";

const source: SourceRow = { id: "loc", name: "LOC Worlds Revealed", kind: "web_list", config: {}, tier: "T1", participation_mode: "editorial", first_party: true, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
const rule: ArchiveRule = { sourceId: "loc", mode: "months", urlTemplate: "https://example.com/maps/{month}/",
  monthPageUrlTemplate: "https://example.com/maps/{month}/page/{page}/", config: {} };
const o: Options = { from: "2026-01-01", to: "2026-02-28", sources: [], maxPages: 10, maxItems: 100, sleepMs: 0, apply: true, state: ".data/state.json" };
const jan1 = "https://example.com/maps/2026/01/", jan2 = "https://example.com/maps/2026/01/page/2/", jan3 = "https://example.com/maps/2026/01/page/3/";
const feb1 = "https://example.com/maps/2026/02/", feb2 = "https://example.com/maps/2026/02/page/2/";
const listing = (month: string, days: number[], slug = ""): Candidate[] => days.map(d => ({
  url: `https://example.com/maps/${month.replace("-", "/")}/post-${slug}${d}`,
  title: `Post ${month}-${slug}${d}`,
  publishedAt: new Date(`${month}-${String(d).padStart(2, "0")}T12:00:00+08:00`),
}));

function harness(fetch: (url: string) => Promise<Candidate[]>) {
  const state: State = { version: 1, completed: [] };
  const requested: string[] = [];
  let checkpoints = 0;
  const deps: Dependencies = {
    fetch: async s => { const url = String(s.config.url); requested.push(url); return fetch(url); },
    store: async () => ({ articleId: "a", created: true, revised: false, backfill: true }),
    queue: async () => "job", checkpoint: async () => { checkpoints++; },
  };
  return { state, requested, checkpoints: () => checkpoints, deps };
}

test("full month pages continue within the month until a 404 ends it without an error", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run({ ...o, to: "2026-01-31" }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2, jan3]);
  assert.equal(stats.pages, 2); // only really fetched continuation pages count
  assert.equal(stats.errors, 0); assert.equal(stats.eligible, 20); assert.equal(stats.limited, false);
  assert.deepEqual(stats.boundaries, []); assert.equal(h.state.boundaries, undefined);
  const prefix = `${o.from}:2026-01-31:loc:`;
  assert.deepEqual(h.state.completed, [`${prefix}${jan1}`, `${prefix}${jan2}`]);
  assert.equal(h.checkpoints(), 22); // 10 items + 1 page per read page; the 404 page stays pending
});

test("a half-full continuation page ends the month and the next month is still walked", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [11, 12, 13]));
    if (url === feb1) return Promise.resolve(listing("2026-02", [1]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run(o, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2, feb1, feb2]); // jan3 never requested
  assert.equal(stats.errors, 0); assert.equal(stats.limited, false); assert.equal(stats.eligible, 14);
});

test("a fully older month page builds a boundary but only ends its own month", async () => {
  const mid = { ...o, from: "2026-01-15" };
  const fetch = (url: string): Promise<Candidate[]> => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [20]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [5]));
    if (url === feb1) return Promise.resolve(listing("2026-02", [5]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  };
  const h = harness(fetch);
  const first = await run(mid, [rule], [source], h.deps, h.state);
  const prefix = `${mid.from}:${mid.to}:loc:`;
  assert.equal(first.errors, 0);
  assert.equal(first.boundaries.length, 1);
  assert.equal(h.state.boundaries![prefix]!.url, jan2);
  assert.ok(h.requested.includes(feb1)); // the boundary ends the month, not the whole months walk
  h.requested.length = 0;
  const second = await run(mid, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan2, feb2]); // completed months stay skipped; their next page is re-checked
  assert.deepEqual(second.boundaries, [{ source: "loc", url: jan2, reused: true }]);
  assert.equal(second.errors, 0);
});

// 回归：月内翻页的两条"静默丢历史"路径（2026-10-12 评审实测出来的，不是假想）。
// ① 一个没读完的月份，下一轮不得因为"第 2 页已确认"就停在那里——后面的页永远不再请求。
//    旧代码在 while 里写 `|| raw === 0` 而 readPage 对已确认页恰好把 raw 留在 0，
//    于是"4 页 41 条、上一轮读到第 3 页"的月份在第二轮请求数为 0，11 条永久丢失且报表干净。
test("a month left half-read is picked up at the next page on the following run", async () => {
  const jan4 = "https://example.com/maps/2026/01/page/4/", jan5 = "https://example.com/maps/2026/01/page/5/";
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    if (url === jan2) return Promise.resolve(listing("2026-01", [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    if (url === jan3) return Promise.resolve(listing("2026-01", [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]));
    if (url === jan4) return Promise.resolve(listing("2026-01", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "later-"));
    if (url === jan5) return Promise.reject(new FetchError("HTTP 404", 404));
    return Promise.resolve([]);
  });
  // 第一轮只允许 3 页：读到第 3 页就被预算截断（生产 archive-cycle 正是 --max-pages=5）
  const first = await run({ ...o, to: "2026-01-31", maxPages: 3 }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2, jan3]);
  assert.equal(first.limited, true, "被页数上限截断必须说出来，否则下一轮看不出来这月没读完");
  h.requested.length = 0;
  // 第二轮放宽上限：必须从**没读过的那一页**接着走，而不是在第 2 页就收工
  const second = await run({ ...o, to: "2026-01-31", maxPages: 10 }, [rule], [source], h.deps, h.state);
  assert.ok(h.requested.includes(jan4), `第二轮必须请求 jan4，实际请求=${JSON.stringify(h.requested)}`);
  assert.equal(second.eligible, 10, "第 4 页那 10 条要进得来");
  assert.equal(second.errors, 0);
});

// ② 某个月的主页为空（或读不出条目）只能结束**那个月**，不能结束整条 months 走法：
//    plan 是从旧到新排的，返回 "error" 会 break 掉整个 plan，于是那一年它之后的月份全部不再进口。
test("an empty month page skips that month and still walks the months after it", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve([]);                       // 一月主页是空的
    if (url === feb1) return Promise.resolve(listing("2026-02", [1, 2, 3]));
    if (url === feb2) return Promise.reject(new FetchError("HTTP 404", 404));
    return Promise.resolve([]);
  });
  const stats = await run(o, [rule], [source], h.deps, h.state);
  assert.ok(h.requested.includes(feb1), `二月仍要被请求，实际=${JSON.stringify(h.requested)}`);
  assert.equal(stats.errors, 1, "一月的覆盖情况未知要记一笔错，不能悄悄算读完");
  assert.equal(stats.eligible, 3, "二月的三条要进来");
});

test("a months rule without monthPageUrlTemplate keeps exactly one fetch per month", async () => {
  const plain: ArchiveRule = { sourceId: "loc", mode: "months", urlTemplate: "https://example.com/maps/{month}/", config: {} };
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1]));
    if (url === feb1) return Promise.resolve(listing("2026-02", [1]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run(o, [plain], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, feb1]); // no continuation attempt at all
  assert.equal(stats.errors, 0); assert.deepEqual(stats.boundaries, []);
});

// 生产周期跑的是 `--max-pages=5` 配九个月的区间（deploy/geohot/archive-cycle.sh:242），也就是"计划本身
// 被页数预算截断"这一格。readPage 看不见它——被截掉的那些月它一次都没被调用。
// 为什么样本要长成"最后一个被排进来的月是空的"：非空时 `readPage` 末尾那句 `last && …` 已经会报
// limited，这条判据就永远不会红（我第一版就是这么写的，把修复关掉照样 10/10 绿）。只有空月提前
// return，才轮到计划层这一格说话。
test("a months plan truncated by the page budget says so even though no page was cut", async () => {
  const plain: ArchiveRule = { sourceId: "loc", mode: "months", urlTemplate: "https://example.com/maps/{month}/", config: {} };
  const mar1 = "https://example.com/maps/2026/03/";
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2]));
    if (url === feb1) return Promise.resolve([]);          // 预算里最后一个被排进来的月是空的
    if (url === mar1) return Promise.resolve(listing("2026-03", [1]));
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const first = await run({ ...o, to: "2026-03-31", maxPages: 2 }, [plain], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, feb1], "预算只够两个月，三月这轮不该被请求");
  assert.equal(first.errors, 1, "二月为空要记一笔错");
  assert.equal(first.limited, true, "月份没排完就是被截断，不能报 limited:false");
  h.requested.length = 0;
  // 预算放宽之后第三月要能补上：截断只是这一轮少跑，不是那个月作废。
  const second = await run({ ...o, to: "2026-03-31", maxPages: 5 }, [plain], [source], h.deps, h.state);
  assert.ok(h.requested.includes(mar1), `放宽预算后三月要补跑，实际=${JSON.stringify(h.requested)}`);
  assert.equal(second.limited, false, "三个月都排进了计划，就不算截断");
});

test("an empty continuation page ends the month without an error or a completion", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3]));
    if (url === jan2) return Promise.resolve([]);
    return Promise.reject(new FetchError("HTTP 404", 404));
  });
  const stats = await run({ ...o, to: "2026-01-31" }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2]);
  assert.equal(stats.errors, 0); assert.equal(stats.eligible, 3);
  assert.deepEqual(h.state.completed, [`${o.from}:2026-01-31:loc:${jan1}`]); // the empty page stays pending
});

test("an unparseable continuation page ends the month without an error", async () => {
  const h = harness(url => {
    if (url === jan1) return Promise.resolve(listing("2026-01", [1, 2, 3]));
    return Promise.reject(new FetchError("no items matched (html)"));
  });
  const stats = await run({ ...o, to: "2026-01-31" }, [rule], [source], h.deps, h.state);
  assert.deepEqual(h.requested, [jan1, jan2]);
  assert.equal(stats.errors, 0); assert.equal(stats.eligible, 3);
  assert.deepEqual(h.state.completed, [`${o.from}:2026-01-31:loc:${jan1}`]);
});

test("monthPageUrlTemplate requires months mode and both placeholders, before any fetch", async () => {
  let fetches = 0;
  const deps: Dependencies = { fetch: async () => { fetches++; return []; } };
  await assert.rejects(run({ ...o, apply: false }, [{ ...rule, mode: "pages" }], [source], deps), /Month pagination/);
  await assert.rejects(run({ ...o, apply: false }, [{ ...rule, monthPageUrlTemplate: "https://example.com/{month}/" }], [source], deps), /Month pagination/);
  await assert.rejects(run({ ...o, apply: false }, [{ ...rule, monthPageUrlTemplate: "https://example.com/{page}/" }], [source], deps), /Month pagination/);
  assert.equal(fetches, 0);
});
