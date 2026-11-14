// 收录池的落盘底稿。
//
// 为什么要有它：内存里那两份（`poolCache` 45 秒、`poolStale` 3 分钟）挡不住重启，也挡不住
// 「进程刚起来、这一页还没人来过」。2026-11-14 站长截图里的「正在取收录池…」就是这么来的：
// 部署或重启后第一个手机读者要等一趟冷查询（主库忙时几十秒），等不到就只能显示加载字样。
// 把每一页成功的答案按 key 落一份到磁盘，进程起来后第一次请求就能直出，后台再去换新的。
//
// 三条克制：只写不读最近 48 页（翻页与筛选的组合再多也不会把磁盘吃掉）、超过 12 小时的底稿
// 当作不存在（宁可让读者等一下，也不给半天前的一页）、写入用临时文件 + rename（半截文件不
// 会被当成底稿读进来）。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";

const DIR = path.join(config.dataDir, "pool-snapshot");
const MAX_FILES = 48;
const MAX_AGE_MS = 12 * 3600_000;

function fileFor(key: string): string {
  return path.join(DIR, `${createHash("sha1").update(key).digest("hex")}.json`);
}

export type PoolSnapshot<T> = { body: T; at: number };

/** 读一份底稿；没有、过期、读坏了都返回 null（调用方照常去查库）。 */
export async function readPoolSnapshot<T>(key: string, now = Date.now()): Promise<PoolSnapshot<T> | null> {
  const file = fileFor(key);
  try {
    const info = await stat(file);
    if (now - info.mtimeMs > MAX_AGE_MS) return null;
    const parsed = JSON.parse(await readFile(file, "utf8")) as { key?: string; body?: T };
    if (parsed?.key !== key || parsed.body === undefined) return null;
    return { body: parsed.body, at: info.mtimeMs };
  } catch {
    return null;
  }
}

/** 写一份底稿。失败只影响「下次冷启动快不快」，不影响这次回答，所以调用方不需要处理异常。 */
export async function writePoolSnapshot(key: string, body: unknown): Promise<void> {
  const file = fileFor(key);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(temp, JSON.stringify({ key, body }), "utf8");
    await rename(temp, file);
    void prune();
  } catch {
    await unlink(temp).catch(() => {});
  }
}

/** 只留最近 MAX_FILES 份：按 mtime 从旧到新删。 */
async function prune(): Promise<void> {
  try {
    const names = (await readdir(DIR)).filter((name) => name.endsWith(".json"));
    if (names.length <= MAX_FILES) return;
    const rows = await Promise.all(names.map(async (name) => {
      const file = path.join(DIR, name);
      try {
        return { file, at: (await stat(file)).mtimeMs };
      } catch {
        return null;
      }
    }));
    const stale = rows.filter((row): row is { file: string; at: number } => row !== null).sort((a, b) => a.at - b.at).slice(0, names.length - MAX_FILES);
    await Promise.all(stale.map((row) => unlink(row.file).catch(() => {})));
  } catch {
    // 目录不存在或没权限：下次写入再来。
  }
}
