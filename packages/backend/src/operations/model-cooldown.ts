// Immediate process-local overlay on the durable ledger health snapshot. No receipts are changed.
// 2026-11-02 生产实测（receipt_attempts 2h 37 次全失败）：autoclaw-cn 的 429 文案是「GLM-5.3 免费额度
// 已用完,开通连续包月会员继续使用」——旧 matcher 只认「额度已用尽」（尽），不认「已用完」（完），
// 这扇门就永远进不了一小时冷却，每次轮转都白烧一次调用。
const QUOTA = /free-models-per-day|insufficient_quota|exceeded your current quota|FreeTierError|今日文本额度已用完|额度已用[尽完]|购买加量包/i;
// 确定性配置拒绝，与 readSick 的 config_refusal（models.ts）同一口径：成员被上游停用（HTTP 404
// "switched off in Magpie"，minimax-code-global 实测形态）或因稳定的参数原因被拒（HTTP 400 code
// 11150 "reasoning effort value is not supported by the current model"，workbuddy-cn 实测形态）。
// 这两类错误换个时刻必然复现——2026-10-30~31 它们在 24h 内烧掉约 985 条 translate_body 收据失败，
// 此前只有 10 分钟失败率窗在管，窗口一过期就复烧。与 quota/auth 同权：命中即冷却一小时。
const CONFIG = /switched off in Magpie|is not supported by the current model/i;
const HOUR = 3600_000;

// 进程重启会忘掉这一小时的冷却：worker 今天被停/起了六十多次，每次重启都把已经确定死掉的成员
// （额度用完、被上游停用、参数被拒）重新放回轮转，等于每重启一次就白烧一次调用。把冷却表落到
// settings 里，进程起来时读回来；写是防抖的、失败只记一行日志——读不到冷却表不该拦住任何一次
// 付费调用，真正的健康判据仍然是 receipts 的 10 分钟窗。
const PERSIST_KEY = "model-cooldown.v1";
const FLUSH_MS = 2_000;

export class ModelCooldown {
  private readonly until = new Map<string, { until: number; generation: number }>();
  private generation = 0;
  private persistent = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushBackoff = 0;

  /** 读回上一个进程落下的冷却。只在进程启动时调用一次；失败只记日志，不改变本地行为。 */
  async load(): Promise<void> {
    const { sql } = await import("../db.ts");
    try {
      // 按条目一行（2026-11-05）：原先整张表压在一行 JSON 上，coordinator 与 content-executor
      // 是两个进程、两套内存 map，谁后落库谁的快照就是唯一真相——对方还活着的冷却被整行抹掉，
      // 重启后读不回来，死成员又被放回轮转。逐条写，各写各的行，谁也不会覆盖谁。
      const rows = await sql<{ key: string; value: { until?: number; generation?: number } }[]>`
        SELECT key, value FROM settings WHERE key LIKE ${`${PERSIST_KEY}:%`}`;
      const now = Date.now();
      for (const row of rows) {
        const key = row.key.slice(PERSIST_KEY.length + 1);
        const entry = row.value;
        if (entry && typeof entry.until === "number" && entry.until > now) {
          this.until.set(key, { until: entry.until, generation: entry.generation ?? 0 });
        }
      }
      this.persistent = true;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", msg: "model cooldown ledger unreadable; starting cold", error: String(error) }));
    }
  }

  private scheduleFlush(delay = FLUSH_MS): void {
    if (!this.persistent || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, delay);
    this.flushTimer.unref?.();
  }

  /** 进程要退出时调用：把还留在内存里的冷却立刻写下去，别等 2 秒的防抖。
   *  2026-11-05 复核：worker 一天被停/起六十多次，退出路径原先只 stopBoss + closeDb，
   *  最后一次 reject() 的冷却会跟着进程一起消失，重启后又把死成员放回轮转。 */
  async flushNow(): Promise<void> {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    // 停机那一刻正好有一次写入在飞（库慢的时候最常见）：等它落地再写一次快照，
    // 否则 flush() 会因为 flushPromise 非空而立刻返回，最新一批冷却跟着进程消失。
    while (this.flushPromise) await this.flushPromise.catch(() => {});
    await this.flush();
  }

  /** 某成员恢复正常：把它的那一行删掉，别让下一个进程重启后读回一条已经不成立的冷却。 */
  private dropRow(key: string): void {
    if (!this.persistent) return;
    void (async () => {
      const { sql } = await import("../db.ts");
      await sql`DELETE FROM settings WHERE key = ${`${PERSIST_KEY}:${key}`}`;
    })().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", msg: "model cooldown row unremovable", key, error: String(error) }));
    });
  }

  private async flush(): Promise<void> {
    // 在飞时直接 return 会丢掉这次落库的请求：reject() 之后 scheduleFlush 已把 timer 清空，
    // 那批 until 要等到下一个事件才写（进程若被 worker 重启打断就永久丢了）。补一次重排。
    if (this.flushPromise) { this.scheduleFlush(); return; }
    const now = Date.now();
    const entries = [...this.until].filter(([, entry]) => entry.until > now);
    this.flushBackoff = 0;
    this.flushPromise = (async () => {
      const { sql } = await import("../db.ts");
      // 逐条一行（2026-11-05）：整行 JSON 快照会被另一个进程的写入整份盖掉。各写各的行，
      // coordinator 与 content-executor 才不会互相抹掉对方还活着的冷却。
      for (const [key, entry] of entries) {
        await sql`INSERT INTO settings (key, value, updated_by, updated_at)
                   VALUES (${`${PERSIST_KEY}:${key}`}, ${sql.json(entry)}, 'model-cooldown', now())
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                     updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
    })().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", msg: "model cooldown ledger unwritable", error: String(error) }));
      // 写不进去时不要按 2 秒的节奏重试：库挂着的时候每一次 reject() 都会把它叫醒，
      // 变成一串注定失败的写入。指数退避到 60 秒封顶，成功一次就回到 2 秒。
      this.flushBackoff = this.flushBackoff === 0 ? FLUSH_MS * 2 : Math.min(this.flushBackoff * 2, 60_000);
      this.scheduleFlush(this.flushBackoff);
    }).finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }
  begin(): number { return this.generation; }
  reject(service: string, model: string, status: number, message: string, now = Date.now()): void {
    // 402 与 401/403 同为确定性拒绝（额度/付费墙，如 Loomy「积分余额不足」），不依赖消息正则——
    // 余额类文案千变万化，命中率永远追不上。命中即冷却一小时，不进 10 分钟失败率窗的复烧循环。
    if (status === 401 || status === 402 || status === 403 || status >= 400 && status < 600 && (QUOTA.test(message) || CONFIG.test(message))) {
      this.until.set(`${service}|${model}`, { until: now + HOUR, generation: ++this.generation });
      this.scheduleFlush();
    }
  }
  accept(service: string, model: string, ticket: number): void {
    const key = `${service}|${model}`, refusal = this.until.get(key);
    // Compare process order, not wall-clock milliseconds: old in-flight successes cannot erase new refusals.
    if (refusal !== undefined && ticket >= refusal.generation) { this.until.delete(key); this.dropRow(key); this.scheduleFlush(); }
  }
  overlay(durable: ReadonlySet<string>, now = Date.now()): Set<string> {
    const result = new Set(durable);
    for (const [key, refusal] of this.until) {
      if (now < refusal.until) result.add(key);
      else this.until.delete(key);
    }
    return result;
  }
}

export const modelCooldown = new ModelCooldown();
