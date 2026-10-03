// 读者存在这台浏览器里的状态：一次写 = 一次"读—合并—写"（app/lib/local-state.ts）。这些用例用一个假的
// window.localStorage 和一个"每个标签页重新求值一次"的模块实例来驱动它。
// 前五个用例从上游 apps/web/tests/local-state.test.ts（提交 8d5a39b）搬过来，键名按本站的口径改；
// 最后三个是本站自己加的（排序偏好的持久化、以及导入也不该覆盖别页的新数据）。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let instance = 0;

/** 一个新开的标签页：快照缓存是空的，存储里可以看到 `stars`。 */
async function reader(stars: unknown[] = []) {
  const values = new Map<string, string>([["aihot-starred-items", JSON.stringify(stars)]]);
  // 这份 window 没有 navigator，也就没有 Web Locks：走的是"浏览器不给锁"那条退路——写照样要落，
  // 而且必须从存储里现在的值开始算，不是从这一页手里的旧快照算。
  const localStorage: FakeStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values, storage: () => (globalThis as unknown as { window: { localStorage: FakeStorage } }).window };
}

const invalidDates = ["not-a-date", "", "999999-01-01", "+275760-09-13T00:00:00.000Z", null, 42, {}];
const displayDate = (value: string) => `${beijingDate(value)} ${beijingTime(value)}`;
const star = (id: string) => ({ id, title: `Title ${id}`, summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false });

test("import normalizes invalid bookmark dates before persisting without dropping bookmarks", async () => {
  const { state, values } = await reader();
  const before = Date.now();
  const result = await state.importBundle(JSON.stringify({ version: 1, starred: invalidDates.map((value, i) => ({
    id: `item-${i}`, title: `Title ${i}`, savedAt: value, publishedAt: value,
  })) }));
  assert.equal(result.starredAdded, invalidDates.length);
  const saved = JSON.parse(values.get(state.KEYS.starred)!);
  assert.equal(saved.length, invalidDates.length);
  for (const item of saved) {
    assert.equal(item.publishedAt, null);
    assert.ok(Date.parse(item.savedAt) >= before && Date.parse(item.savedAt) <= Date.now());
    assert.doesNotThrow(() => displayDate(item.savedAt));
  }
});

test("existing invalid dates are readable, exportable and removable after reopening the page", async () => {
  const { state } = await reader([{ id: "old", title: "Keep this bookmark", savedAt: "broken", publishedAt: "broken" }]);
  const stars = state.getStarred();
  assert.equal(stars.length, 1);
  assert.equal(stars[0]!.title, "Keep this bookmark");
  assert.equal(stars[0]!.publishedAt, null);
  assert.doesNotThrow(() => displayDate(stars[0]!.savedAt));
  assert.strictEqual(state.getStarred(), stars, "normalization preserves stable React snapshots");
  assert.deepEqual(state.exportBundle().starred, stars);
  await state.removeStar("old");
  assert.deepEqual(state.getStarred(), []);
});

test("valid dates and existing bookmarks survive import unchanged", async () => {
  const item = { id: "valid", title: "Original title", savedAt: "2026-09-29T08:30:00+08:00", publishedAt: "2026-09-28T23:00:00Z" };
  const { state } = await reader([item]);
  const result = await state.importBundle(JSON.stringify({ version: 1, starred: [{ ...item, title: "Replacement", savedAt: "broken" }] }));
  assert.equal(result.starredAdded, 0);
  const [saved] = state.getStarred();
  assert.equal(saved!.title, item.title);
  assert.equal(saved!.savedAt, item.savedAt);
  assert.equal(saved!.publishedAt, item.publishedAt);
});

test("a cached tab merges newer saved bookmarks and read marks before writing", async () => {
  const { state, values } = await reader([{ id: "old", title: "Old" }]);
  state.getStarred();
  state.getReadIds();
  // 另一个标签页先写完了：这一页手里的快照已经是旧的。
  values.set(state.KEYS.starred, JSON.stringify([{ id: "other-tab", title: "Other tab" }, { id: "old", title: "Old" }]));
  values.set(state.KEYS.read, JSON.stringify(["other-tab"]));
  await state.toggleStar(star("new"));
  await state.markRead("new");
  assert.deepEqual(state.getStarred().map((s) => s.id), ["new", "other-tab", "old"]);
  assert.deepEqual(state.getReadIds(), ["new", "other-tab"]);
});

test("failed bookmark writes and damaged existing data do not report a successful toggle", async () => {
  const { state, values, storage } = await reader();
  const item = star("new");
  // 收藏那份存储自己坏了（不是没写过）：这一笔既不覆盖它，也不能说"收藏好了"。
  values.set(state.KEYS.starred, "damaged original data");
  assert.equal(await state.toggleStar(item), false);
  assert.equal(values.get(state.KEYS.starred), "damaged original data");
  // 写不进去（配额满、隐私设置挡了存储）同样不算成功。
  values.set(state.KEYS.starred, "[]");
  storage().localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: () => { throw new Error("quota"); }, removeItem: (key: string) => { values.delete(key); } };
  assert.equal(await state.toggleStar(item), false);
  assert.deepEqual(state.getStarred(), [], "读得出来的那一份不受影响");
});

test("an import merges what another tab saved instead of replacing it", async () => {
  const { state, values } = await reader([{ id: "old", title: "Old" }]);
  state.getStarred();
  values.set(state.KEYS.starred, JSON.stringify([{ id: "other-tab", title: "Other tab", savedAt: "2026-09-29T08:30:00+08:00" }]));
  const report = await state.importBundle(JSON.stringify({ version: 1, starred: [star("new")] }));
  assert.equal(report.starredAdded, 1);
  assert.deepEqual(state.getStarred().map((s) => s.id).sort(), ["new", "other-tab"]);
});

test("a damaged bookmark store refuses an import instead of overwriting it", async () => {
  const { state, values } = await reader();
  values.set(state.KEYS.starred, "{这不是数组}");
  await assert.rejects(
    () => state.importBundle(JSON.stringify({ version: 1, starred: [star("new")] })),
    /无法读取/,
  );
  assert.equal(values.get(state.KEYS.starred), "{这不是数组}", "导入失败时一个字节都没动");
});

test("the story timeline order persists in this browser and defaults to newest first", async () => {
  const { state, values } = await reader();
  assert.equal(state.getTimelineOrder(), "desc", "没写过就是最新在前");
  state.setTimelineOrder("asc");
  assert.equal(values.get(state.KEYS.timelineOrder), "asc");
  assert.equal(state.getTimelineOrder(), "asc");
  // 存进来一个不认识的值为"什么都没记住"：脏数据不能把默认排序改掉。
  values.set(state.KEYS.timelineOrder, "banana");
  assert.equal(state.getTimelineOrder(), "desc");
});

test("the order preference stays out of the export bundle readers already have", async () => {
  const { state } = await reader();
  state.setTimelineOrder("asc");
  assert.deepEqual(Object.keys(state.exportBundle()).sort(), ["read", "starred", "theme", "version"]);
});
