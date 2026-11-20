/**
 * A bounded admission gate: rejected work allocates no queue entry.
 *
 * 2026-11-18 事故复盘：槽位释放原先挂在 `await work()` 的 settle 上——底层承诺一旦永不
 * settle（半开 socket、查询挂死），槽位就被永久占住，后续请求在 1–3 ms 内拿到
 * `PublicReadBusyError`，而数据库本身是健康的。这里把「还槽」与「work 是否结束」解耦：
 *  admitted 工作带一个墙钟截止时间，到点强制还槽；迟到的 settle 受单次释放守卫保护，
 *  既不会重复还槽，也不会再占新槽。
 */

/** Queue is full: the caller was rejected without taking a queue entry. */
export class CapacityExceeded extends Error {
  readonly reason = "capacity_exceeded";
}

/**
 * Admitted work did not settle within its wall-clock deadline. The slot has already been
 * released independently of the underlying promise; whatever that promise does later is
 * invisible to the gate.
 */
export class CapacityTimeout extends Error {
  readonly reason = "gate_timeout";
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`admitted work timed out after ${deadlineMs}ms`);
    this.deadlineMs = deadlineMs;
  }
}

export interface CapacityRunOptions {
  /** Wall-clock deadline for admitted work. On expiry the slot is released even if the work promise never settles. */
  timeoutMs?: number;
  /** Wall-clock deadline for waiting in the queue before admission. */
  queueTimeoutMs?: number;
}

export class CapacityGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly limit: number;
  private readonly queueLimit: number;

  constructor(limit: number, queueLimit: number) {
    this.limit = limit;
    this.queueLimit = queueLimit;
  }

  /** In-flight count (diagnostics / tests). */
  get activeCount(): number { return this.active; }
  /** Queued count (diagnostics / tests). */
  get queuedCount(): number { return this.waiting.length; }

  async run<T>(work: () => Promise<T>, options: CapacityRunOptions = {}): Promise<T> {
    await this.acquire(options.queueTimeoutMs);

    // Per-acquisition release guard: the slot is released exactly once. A late settle of a
    // work promise that already timed out must not decrement `active` a second time, and it
    // can never loop back through `acquire` to take a fresh slot.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // Hand the slot over to the oldest waiter instead of dropping it: the woken holder is
      // already counted in `active`, so this branch must not decrement.
      if (next) next();
      else this.active--;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = options.timeoutMs;
    const workPromise = work();
    // 兜底吞掉迟到的拒绝：超时强制还槽后，底层承诺仍可能晚到失败；不挂 catch 会变成
    // unhandled rejection。迟到 settle 已被 release 守卫挡住，不会重复还槽。
    void workPromise.catch(() => {});
    const outcome = deadline === undefined
      ? workPromise
      : Promise.race([
          workPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new CapacityTimeout(deadline)), deadline);
          }),
        ]);

    try {
      return await outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
  }

  /** Take a slot, waiting in the bounded queue if all slots are busy. Resolves without
   *  incrementing `active` when woken by a holder's handover (the holder's count covers us). */
  private acquire(queueTimeoutMs?: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.queueLimit) {
      return Promise.reject(new CapacityExceeded("capacity temporarily exhausted"));
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      if (queueTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new CapacityTimeout(queueTimeoutMs));
        }, queueTimeoutMs);
      }
      this.waiting.push(entry);
    });
  }
}
