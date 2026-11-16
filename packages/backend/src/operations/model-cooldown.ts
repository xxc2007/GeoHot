// Immediate process-local overlay on the durable ledger health snapshot. No receipts are changed.
// 2026-11-02 生产实测（receipt_attempts 2h 37 次全失败）：autoclaw-cn 的 429 文案是「GLM-5.3 免费额度
// 已用完,开通连续包月会员继续使用」——旧 matcher 只认「额度已用尽」（尽），不认「已用完」（完），
// 这扇门就永远进不了一小时冷却，每次轮转都白烧一次调用。
const DAILY_QUOTA = /free-models-per-day|insufficient_quota|exceeded your current quota|FreeTierError|今日文本额度已用完|额度已用[尽完]|购买加量包|insufficient balance|积分余额不足/i;
// 分钟级限流：不是日额度撞墙，是 RPM 被敲。这类错误带 Retry-After 秒数时按秒冷却，不带时保守 60s。
// （正则在 llm.ts classifyRejection 里使用，此处仅导出供测试断言。）
export const RATE_LIMIT = /usage exceeds frequency limit|usage limit reached|您的使用量已超出频率限制|API 速率限制|too many requests|rate limit/i;
// 确定性配置拒绝，与 readSick 的 config_refusal（models.ts）同一口径：成员被上游停用（HTTP 404
// "switched off in Magpie"，minimax-code-global 实测形态）或因稳定的参数原因被拒（HTTP 400 code
// 11150 "reasoning effort value is not supported by the current model"，workbuddy-cn 实测形态）。
// 这两类错误换个时刻必然复现——2026-10-30~31 它们在 24h 内烧掉约 985 条 translate_body 收据失败，
// 此前只有 10 分钟失败率窗在管，窗口一过期就复烧。与 quota/auth 同权：命中即冷却一小时。
// 2026-11-06 再补三族：`unknown or disabled model`（qoder-cn/dfmodel 的网关侧已下线）、
// `account is signed out`（minimax-code 两个成员，6 小时 373 次失败）、`request illegal`
// （workbuddy 3065 整条通道对任何模型都 403，6 小时 127 次失败）。这三族都是"换个时刻必然
// 复现"的确定性拒绝，不带冷却就是每轮轮转白烧一次调用。
const CONFIG = /switched off in Magpie|is not supported by the current model|unknown or disabled model|account is signed out|sign in again|request illegal/i;
// 账号被停用/封禁：即使被 Magpie 包装成 502，body 里仍带 code=100003 或 account suspended 文案。
// 这是认证/账号状态问题，不是 429，也不是证明永久封禁——冷却 1 小时后由真实小工作验证恢复。
const ACCOUNT_SUSPENDED = /100003|account[^\n]{0,40}(suspended|disabled|banned|停用|封禁)|账号[^\n]{0,20}(已被停用|已被封禁|被停)/i;

const HOUR = 3600_000;
const MINUTE = 60_000;
const MAX_COOLDOWN_MS = 48 * HOUR; // 上游给的 reset 时间戳封顶 48h，防离谱值

export type CooldownCategory =
  | "quota_day"   // 日额度/账号额度耗尽，有 reset 时按 reset 冷却，无则保守 1h
  | "rate_minute" // 分钟级限流，按 Retry-After 秒数冷却，无则 60s
  | "auth"        // 401/403/账号停用：确定性认证问题，冷却 1h，等运维或真实成功
  | "config";     // 配置拒绝（switched off / 参数不支持 / 渠道拒认），冷却 1h

interface CooldownEntry {
  until: number;
  generation: number;
  category: CooldownCategory;
  evidenceAt: number;
  /** 上游明确给出的恢复时间戳（来自 Retry-After 或 body 里的 reset at）。缺省=未拿到。 */
  resetAt?: number;
  /** true=until 是我们保守默认的，不是上游给的；false=until 来自上游证据。 */
  resetAssumed: boolean;
}

// 进程重启会忘掉这一小时的冷却：worker 今天被停/起了六十多次，每次重启都把已经确定死掉的成员
// （额度用完、被上游停用、参数被拒）重新放回轮转，等于每重启一次就白烧一次调用。把冷却表落到
// settings 里，进程起来时读回来；写是防抖的、失败只记一行日志——读不到冷却表不该拦住任何一次
// 付费调用，真正的健康判据仍然是 receipts 的 10 分钟窗。
const PERSIST_KEY = "model-cooldown.v1";
const FLUSH_MS = 2_000;

export class ModelCooldown {
  private readonly until = new Map<string, CooldownEntry>();
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
      const rows = await sql<{ key: string; value: Partial<CooldownEntry> & { until?: number; generation?: number } }[]>`
        SELECT key, value FROM settings WHERE key LIKE ${`${PERSIST_KEY}:%`}`;
      const now = Date.now();
      for (const row of rows) {
        const key = row.key.slice(PERSIST_KEY.length + 1);
        const entry = row.value;
        if (entry && typeof entry.until === "number" && entry.until > now) {
          // 旧形状（v1 之前只有 {until, generation}）：category/evidenceAt/resetAt 缺省补全。
          this.until.set(key, {
            until: entry.until,
            generation: entry.generation ?? 0,
            category: entry.category ?? "config",
            evidenceAt: entry.evidenceAt ?? entry.until - HOUR,
            resetAt: entry.resetAt,
            resetAssumed: entry.resetAssumed ?? false,
          });
        }
      }
      // 旧账本迁移：升级前的进程把整张表写在一行 JSON 上（`model-cooldown.v1`）。不认它，
      // 升级这一刻还活着的拒绝就凭空消失、死成员被放回轮转。读出、铺成一条成员一行，再删旧行。
      const [legacy] = await sql<{ value: Record<string, Partial<CooldownEntry>> }[]>`
        SELECT value FROM settings WHERE key = ${PERSIST_KEY}`;
      if (legacy && legacy.value && typeof legacy.value === "object") {
        const carried = Object.entries(legacy.value).filter(([, entry]) => entry && typeof entry.until === "number" && entry.until > now);
        for (const [key, entry] of carried) {
          if (!this.until.has(key)) this.until.set(key, {
            until: entry.until!,
            generation: entry.generation ?? 0,
            category: entry.category ?? "config",
            evidenceAt: entry.evidenceAt ?? entry.until! - HOUR,
            resetAt: entry.resetAt,
            resetAssumed: entry.resetAssumed ?? false,
          });
        }
        const entries = [...this.until].filter(([, entry]) => entry.until > now);
        for (const [key, entry] of entries) {
          await sql`INSERT INTO settings (key, value, updated_by, updated_at)
                     VALUES (${`${PERSIST_KEY}:${key}`}, ${sql.json({ ...entry })}, 'model-cooldown', now())
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        }
        await sql`DELETE FROM settings WHERE key = ${PERSIST_KEY}`;
        console.log(JSON.stringify({ level: "info", msg: "model cooldown ledger migrated to per-member rows", carried: carried.length }));
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
                   VALUES (${`${PERSIST_KEY}:${key}`}, ${sql.json({ ...entry })}, 'model-cooldown', now())
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

  /**
   * 记录一次冷却。category/resetAt 由调用方（llm.ts）根据上游响应头与 body 判定后传入；
   * 不传时这里按正则保守回退，保持与旧测试兼容。
   *
   * @param opts.category   拒绝分类；不传则按 status+message 正则回退
   * @param opts.resetAt    上游明确给出的恢复时间戳（Retry-After 或 body 里的 reset at）；不传则保守默认
   * @param opts.resetAssumed true=until 是我们保守默认的，不是上游给的
   * @param opts.now        注入时钟（测试用）
   */
  reject(
    service: string,
    model: string,
    status: number,
    message: string,
    opts?: { category?: CooldownCategory; resetAt?: number; resetAssumed?: boolean; now?: number } | number,
  ): void {
    // 兼容旧调用：第 5 参为 number 时当作 now（旧测试与旧调用方）。
    let options: { category?: CooldownCategory; resetAt?: number; resetAssumed?: boolean; now?: number };
    if (typeof opts === "number") {
      options = { now: opts };
    } else {
      options = opts ?? {};
    }
    const now = options.now ?? Date.now();
    let category = options.category;
    // 回退判定：调用方没传 category 时按 status + 文案正则保守识别。
    if (!category) {
      if (status === 401 || status === 403) category = "auth";
      else if (status === 402) category = DAILY_QUOTA.test(message) ? "quota_day" : "auth";
      else if (status === 400 || status === 404) category = CONFIG.test(message) ? "config" : "auth";
      else if (status === 429) {
        // 显式日额度文案才进 1h 冷却；纯分钟级限流（无 Retry-After）交给 10 分钟失败率窗
        if (DAILY_QUOTA.test(message)) category = "quota_day";
        else return;
      }
      else if (status >= 500) {
        // 5xx：body 明确带账号停用或配置拒绝时才冷却（Magpie 会把 400/403 包成 502）
        if (ACCOUNT_SUSPENDED.test(message)) category = "auth";
        else if (CONFIG.test(message)) category = "config";
        else return;
      }
      else return; // 通用 5xx/连接错误：不进 1h 冷却，交给 10 分钟失败率窗
    }
    let until: number;
    let resetAt = options.resetAt;
    let resetAssumed = options.resetAssumed ?? false;
    if (category === "quota_day") {
      if (resetAt && resetAt > now) {
        until = Math.min(resetAt, now + MAX_COOLDOWN_MS);
        resetAssumed = false;
      } else {
        until = now + HOUR;
        resetAt = undefined;
        resetAssumed = true;
      }
    } else if (category === "rate_minute") {
      if (resetAt && resetAt > now) {
        until = Math.min(resetAt, now + 30 * MINUTE);
        resetAssumed = false;
      } else {
        until = now + MINUTE;
        resetAt = undefined;
        resetAssumed = true;
      }
    } else {
      // auth / config：必须运维介入或一次真实成功调用解除，不依赖上游 reset 时间戳
      until = now + HOUR;
      resetAt = undefined;
      resetAssumed = false;
    }
    this.until.set(`${service}|${model}`, {
      until, generation: ++this.generation, category,
      evidenceAt: now, resetAt, resetAssumed,
    });
    this.scheduleFlush();
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

  /**
   * 后台只读快照：返回当前所有未过期的冷却条目，供 admin 模型页展示。
   * 只返回分类与时间戳，不回显上游 body 原文（body 可能带凭据/内部信息）。
   */
  inspect(now: number = Date.now()): Array<{
    key: string; service: string; model: string;
    category: CooldownCategory; evidenceAt: number; until: number;
    resetAt: number | null; resetAssumed: boolean;
  }> {
    const out: Array<{
      key: string; service: string; model: string;
      category: CooldownCategory; evidenceAt: number; until: number;
      resetAt: number | null; resetAssumed: boolean;
    }> = [];
    for (const [key, e] of this.until) {
      if (now >= e.until) continue;
      const sep = key.indexOf("|");
      const service = sep >= 0 ? key.slice(0, sep) : key;
      const model = sep >= 0 ? key.slice(sep + 1) : "";
      out.push({
        key, service, model,
        category: e.category, evidenceAt: e.evidenceAt, until: e.until,
        resetAt: e.resetAt ?? null, resetAssumed: e.resetAssumed,
      });
    }
    return out;
  }
}

export const modelCooldown = new ModelCooldown();
