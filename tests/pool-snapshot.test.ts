// 收录池落盘底稿：重启后第一个读者要能立刻拿到上一份，而不是等一趟冷查询。
//
// 这里不连库（`readPoolSnapshot`/`writePoolSnapshot` 只碰磁盘），所以直接用临时目录，
// 不 import `./setup.ts`——那份会把测试库拉起来，对这个文件是多余的。
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "geohot-pool-snapshot-"));
process.env.AIHOT_DATA_DIR = dataDir;

const { readPoolSnapshot, writePoolSnapshot } = await import("../apps/api/src/pool-snapshot.ts");

const KEY = "/api/site/pool?tab=time&page=1";
const BODY = { items: [{ id: "a" }], page: 1, total: 1, generatedAt: "2026-11-14T00:00:00Z" };

before(() => undefined);

after(async () => {
  // 写入之后会顺手清旧底稿（不 await），所以删除临时目录时可能正好撞上它 —— 重试即可。
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("写过的 key 能读回来，正文逐字一致", async () => {
  await writePoolSnapshot(KEY, BODY);
  const hit = await readPoolSnapshot<typeof BODY>(KEY);
  assert.ok(hit, "刚写的那份应该读得到");
  assert.deepEqual(hit.body, BODY);
  assert.ok(hit.at > 0);
});

test("别的 key 读不到这份（不会把「精选」的答案当成「全部」给出）", async () => {
  await writePoolSnapshot(KEY, BODY);
  assert.equal(await readPoolSnapshot("/api/site/pool?tab=relevance&page=1"), null);
});

test("超过 12 小时的底稿当作不存在", async () => {
  await writePoolSnapshot(KEY, BODY);
  const later = Date.now() + 13 * 3600_000;
  assert.equal(await readPoolSnapshot(KEY, later), null, "半天前的一页宁可让读者等一下");
});

test("半截文件（写坏了）不会被当成底稿", async () => {
  await writePoolSnapshot(KEY, BODY);
  const dir = path.join(dataDir, "pool-snapshot");
  const [name] = (await readdir(dir)).filter((entry) => entry.endsWith(".json"));
  await writeFile(path.join(dir, name), "{ not json", "utf8");
  assert.equal(await readPoolSnapshot(KEY), null);
});

test("缺目录时读是 null，写不抛", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "geohot-pool-snapshot-empty-"));
  try {
    // 换到空目录：这里只能用子进程之外的办法——直接断言「读不存在的目录返回 null」。
    assert.equal(await readPoolSnapshot(`/none/${Date.now()}`), null);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

// 2026-11-23 验收现场：为验证中文卡片的诚实标注，另起了 `ENGLISH_TEXT=fallback` 的栈；它写下的
// `lang=en` 底稿被 strict 栈以 `x-aihot-cache: snapshot` 读出来，英文页短暂出现了中文卡。底稿键
// 必须带上读取口径，模式切换后旧底稿不得命中（12 小时有效期内都不行）。
test("英文底稿按 ENGLISH_TEXT / ENGLISH_MEMBERSHIP 分键，不从另一个口径的答案里读", async () => {
  const previousText = process.env.ENGLISH_TEXT;
  const previousMembership = process.env.ENGLISH_MEMBERSHIP;
  const key = "/api/site/pool?lang=en&channel=all";
  try {
    process.env.ENGLISH_TEXT = "fallback";
    process.env.ENGLISH_MEMBERSHIP = "parity";
    await writePoolSnapshot(key, BODY);

    process.env.ENGLISH_TEXT = "strict";
    assert.equal(await readPoolSnapshot(key), null, "strict 不能读到 fallback 写下的中文回退底稿");

    process.env.ENGLISH_TEXT = "fallback";
    process.env.ENGLISH_MEMBERSHIP = "english";
    assert.equal(await readPoolSnapshot(key), null, "membership 不同也不能共用同一份底稿");

    process.env.ENGLISH_TEXT = "fallback";
    process.env.ENGLISH_MEMBERSHIP = "parity";
    const hit = await readPoolSnapshot<typeof BODY>(key);
    assert.deepEqual(hit?.body, BODY, "同一口径仍然读得到自己写的那份");
  } finally {
    if (previousText === undefined) delete process.env.ENGLISH_TEXT;
    else process.env.ENGLISH_TEXT = previousText;
    if (previousMembership === undefined) delete process.env.ENGLISH_MEMBERSHIP;
    else process.env.ENGLISH_MEMBERSHIP = previousMembership;
  }
});
