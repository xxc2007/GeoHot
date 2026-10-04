// The「一手」chip was removed from the filter row on 2026-10-04 晚 by the owner's request ("有点多余了").
// What makes that removal worth a test at all is how little of it was visible: the chip, the enum key and the
// SQL alias were three lines in three files, and both the chip list and the label table are derived — re-adding
// one without the others either fails to compile (exhaustive `Record<ChannelKey, string>`) or brings back a
// filter the owner asked to drop. The row must stay 全部 + the seven categories, and a link that still carries
// `?channel=firstParty` must keep landing on the unfiltered list rather than a 400 or a half-lit row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATEGORY_KEYS, CHANNEL_KEYS, CHANNEL_LABELS } from "@aihot/contracts/taxonomy";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const filters = read("../apps/web/app/features/feed/Filters.tsx");
const home = read("../apps/web/app/routes/home.tsx");
const all = read("../apps/web/app/routes/all.tsx");
const timeline = read("../apps/web/app/features/feed/Timeline.tsx");
const groupUrls = read("../apps/web/app/features/feed/group-urls.ts");

test("筛选栏只有 全部 + 七个分类，chip 从 CATEGORY_KEYS 派生", () => {
  // Comments here name the removed chip on purpose (that is how a reader learns why it is gone), so the
  // assertions look at the chip list itself: a key or a label, not the word in prose.
  assert.equal(/key:\s*"firstParty"|channel:\s*"firstParty"/.test(filters), false, "Filters.tsx 的 chip 清单里又出现了 firstParty：站长 2026-10-04 要求删掉「一手」那颗 chip，别把它加回来");
  assert.equal(filters.includes('label: "一手"'), false, "Filters.tsx 里又挂出了「一手」这个标签");
  assert.ok(filters.includes("...CATEGORY_KEYS.map("), "分类 chip 必须从 CATEGORY_KEYS 派生（手写清单就会漂）");
  assert.equal(CATEGORY_KEYS.length, 7, `分类数变了（${CATEGORY_KEYS.length} 个）：筛选栏的断言与 README 的「八个格子」都要跟着改`);
});

test("一手不再是一个渠道 key，但老链接要把渠道兜底成 all", () => {
  assert.equal((CHANNEL_KEYS as readonly string[]).includes("firstParty"), false, "firstParty 还在 CHANNEL_KEYS 里：它会让 isChannelKey 认出一个已经没人提供的渠道");
  assert.equal(Object.keys(CHANNEL_LABELS).includes("firstParty"), false, "CHANNEL_LABELS 里还留着一手的标签");
  // 兜底在两条路由上各写了一次：认不出的 channel 回落 all，而不是 400/404。
  assert.match(home, /isChannelKey\(channelParam\) \? channelParam : "all"/, "home.tsx 的渠道兜底没了：老链接 ?channel=firstParty 会掉进未处理分支");
  assert.match(all, /isChannelKey\(channelParam\) \? channelParam : "all"/, "all.tsx 的渠道兜底没了");
});

test("读者可见的链接与游标里不再生成 channel=firstParty", () => {
  for (const [name, src] of [["Filters.tsx", filters], ["Timeline.tsx", timeline], ["group-urls.ts", groupUrls]] as const) {
    assert.equal(/channel:\s*"firstParty"|set\("channel",\s*"firstParty"\)/.test(src), false, `${name} 里仍在拼一手渠道的参数`);
  }
});
