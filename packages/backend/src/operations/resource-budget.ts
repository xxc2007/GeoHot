import { readFileSync, statfsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { positiveInt } from "../config.ts";

/** Opt-in for the small production host; local configuration and ordinary workers keep their policy. */
export function balancedResources(): boolean {
  const value = process.env.GEOHOT_RESOURCE_PROFILE;
  if (value && value !== "balanced") throw new Error("GEOHOT_RESOURCE_PROFILE must be balanced or unset");
  return value === "balanced";
}

/** 读者面能看到的活先跑：这两个数字只用来把「能过读者门禁的条目」排到队列前面。 */
export const PUBLISHABLE_BOOST = 100_000_000;
const MAX_PRIORITY = 2_147_483_646;

/**
 * Prioritise fresh work without changing publication dates or the historical-content boundary.
 *
 * `publishable`（来源允许站内全文）的活再加一档：2026-11-05 现场是 analyze 队列里 7,432 条
 * `created`，其中大头是「只准摘要、永远过不了读者门禁」的来信，把 284 篇可以公开的条目堵在后面。
 * 抬高一档不改变任何一篇文章的处理方式，只改谁先被领取。
 */
export function realTimePriority(input: { historical: boolean; archive: boolean; signal: boolean; observedAt: number; publishable?: boolean }, now = Date.now()): number {
  if (input.historical) return input.archive ? -1 : -2;
  if (!balancedResources()) return input.signal ? -1 : 0;
  // A minute-based key keeps newer arrivals ahead even when an old job has waited long enough
  // to cross an age band. Historical work retains its negative priority and remains queued.
  const minute = Number.isFinite(input.observedAt) ? Math.floor(Math.min(input.observedAt, now) / 60_000) : 0;
  const priority = Math.min(MAX_PRIORITY, Math.max(20, minute * 2));
  const boost = input.publishable ? PUBLISHABLE_BOOST : 0;
  return Math.min(MAX_PRIORITY, priority + boost) - (input.signal ? 1 : 0);
}

export interface ResourceSample {
  availableMiB: number;
  memoryFull: number;
  ioFull: number;
  cpuSome: number;
  diskFreeMiB: number;
  loadPerCpu: number;
}

export function readResourceSample(): ResourceSample {
  const pressure = (resource: string, kind: string) => {
    const text = readFileSync(`/proc/pressure/${resource}`, "utf8");
    const match = new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text);
    return match ? Number(match[1]) : NaN;
  };
  const mem = /^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"));
  const disk = statfsSync(process.cwd());
  return {
    availableMiB: mem ? Number(mem[1]) / 1024 : NaN,
    memoryFull: pressure("memory", "full"),
    ioFull: pressure("io", "full"),
    cpuSome: pressure("cpu", "some"),
    diskFreeMiB: disk.bavail * disk.bsize / 1024 ** 2,
    loadPerCpu: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) / availableParallelism(),
  };
}

/**
 * 压力阈值是"这台机器多大才不算过载"的判断，默认值来自一台更宽裕的机器（891MB 的线上机
 * 24 小时有 15–20 的 memoryFull 是常态）。2026-11-04 生产实测：`memoryFull` 长期在 20–23、
 * `ioFull` 37–44，而 `resourcePressured()` 的门是 20 / 50 ⇒ 取任务几乎全程被暂停，队列每小时
 * 只消化 21 条。把阈值做成人可调的旋钮（**默认值一字未改**），站上就能自己决定"多让一点"
 * 还是"多压一点"，而不必改代码。
 */
// 配置数字一律走 config.positiveInt（tests/env-valves.test.ts 钉着这条：手写
// `Number(process.env.X || …)` 会把一个拼写错误变成 NaN，然后静默改变行为）。
const threshold = (name: string, fallback: number): number => positiveInt(process.env[name], name, fallback);

export function resourcePressured(sample: ResourceSample): boolean {
  return !Object.values(sample).every(Number.isFinite)
    || sample.availableMiB < threshold("GEOHOT_PRESSURE_AVAILABLE_MIB", 64)
    || sample.memoryFull >= threshold("GEOHOT_PRESSURE_MEMORY_FULL", 20)
    || sample.ioFull >= threshold("GEOHOT_PRESSURE_IO_FULL", 50)
    || sample.cpuSome >= threshold("GEOHOT_PRESSURE_CPU_SOME", 75)
    || sample.loadPerCpu >= threshold("GEOHOT_PRESSURE_LOAD_PER_CPU", 2)
    || sample.diskFreeMiB < 2048;
}

/** Check between repeatable scan items; never interrupts an in-flight paid call. */
export function resourceHeadroom(): boolean {
  if (!balancedResources()) return true;
  try {
    const s = readResourceSample();
    return !resourcePressured(s) && s.availableMiB >= threshold("GEOHOT_HEADROOM_AVAILABLE_MIB", 80)
      && s.memoryFull < threshold("GEOHOT_HEADROOM_MEMORY_FULL", 15) && s.ioFull < threshold("GEOHOT_HEADROOM_IO_FULL", 40);
  } catch { return false; }
}

export function scheduledResourcePressured(sample: ResourceSample): boolean {
  return resourcePressured(sample) || sample.availableMiB < threshold("GEOHOT_HEADROOM_AVAILABLE_MIB", 80)
    || sample.memoryFull >= threshold("GEOHOT_HEADROOM_MEMORY_FULL", 15) || sample.ioFull >= threshold("GEOHOT_HEADROOM_IO_FULL", 40);
}

// Only repeatable scans are deferred. Their article/source work stays in PostgreSQL and the next
// cron occurrence revisits it. Never use this policy to complete a claimed article job without work,
// or to discard a daily/weekly/monthly report, backup, recovery or operator request.
const REPEATABLE = new Set([
  "content.sweep", "content.translate", "sources.reserves", "sources.mp-reconcile",
  "hot.rank", "hot.snapshot", "stories.status", "stories.links", "reports.catch-up",
]);

/** 两个名额：一个常规扫描 + 一个翻译；再多就会和读者面抢内存。 */
export const RECURRING_TASK_SLOTS = 2;
function recurringSlots(): number {
  const raw = Number(process.env.GEOHOT_RECURRING_SLOTS ?? "");
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 4 ? raw : RECURRING_TASK_SLOTS;
}

export class ResourceBudget {
  private healthySince: number | undefined;
  private paused = true;
  /**
   * 2026-11-07 现场：杭州这台 `WORKER_ROLE=all` 的机器只有 **一个** 循环任务名额，
   * `cron.content.translate` 每 4 分钟触发一次却几乎每次都被 sweep/rank/digest 占着，
   * 日志里连着 `recurring task deferred … reason: recurring-task-slot-busy`。
   * 结果是译文一直不 complete ⇒ `workflowReadyCondition()` 不放行 ⇒ 读者面整天没有新内容。
   * 名额给到 2：翻译可以和一个常规扫描并行，但不会无限叠加。
   */
  private active = 0;
  private readonly slots = recurringSlots();

  observe(sample: ResourceSample, now: number): boolean {
    const finite = Object.values(sample).every(Number.isFinite);
    const pressured = scheduledResourcePressured(sample);
    const recovered = finite && sample.availableMiB >= 96 && sample.memoryFull < 10 && sample.ioFull < 30
      && sample.cpuSome < 40 && sample.loadPerCpu < 1.5 && sample.diskFreeMiB >= 3072;
    if (pressured) { this.paused = true; this.healthySince = undefined; }
    if (this.paused) {
      if (!recovered) this.healthySince = undefined;
      else this.healthySince ??= now;
      if (this.healthySince !== undefined && now - this.healthySince >= 30_000) this.paused = false;
    }
    return pressured;
  }

  async run<T>(name: string, fn: () => Promise<T>, sample: ResourceSample, now: number, admitted = false): Promise<T | { deferred: true; reason: string }> {
    if (!REPEATABLE.has(name)) return fn();
    const pressured = this.observe(sample, now);
    // Translation's pg-boss claim already passed the shared intake recovery window and reserved
    // processing capacity. Retain the immediate scan limits without requiring another sparse
    // cron sample to reconstruct that same healthy window. Other schedules retain their policy.
    const intakeAdmittedTranslation = admitted && name === "content.translate" && !pressured;
    if (this.paused && !intakeAdmittedTranslation) return { deferred: true, reason: pressured ? "resource-pressure" : "resource-recovery-window" };
    if (this.active >= this.slots) return { deferred: true, reason: "recurring-task-slot-busy" };
    this.active += 1;
    try { return await fn(); } finally { this.active -= 1; }
  }
}

const budget = new ResourceBudget();
/** Frequent intake telemetry measures the same recovery window even between sparse cron ticks. */
export function observeScheduledResources(sample: ResourceSample, now: number) { budget.observe(sample, now); }
export async function runScheduledWithResources<T>(name: string, fn: () => Promise<T>, intakeAdmitted = false) {
  if (!balancedResources() || !REPEATABLE.has(name)) return fn();
  let sample: ResourceSample;
  try { sample = readResourceSample(); } catch {
    // An unreadable pressure gauge is not permission to start another expensive scan.
    return { deferred: true, reason: "resource-telemetry-unavailable" };
  }
  const result = await budget.run(name, fn, sample, Date.now(), intakeAdmitted);
  if (result && typeof result === "object" && "deferred" in result) {
    console.log(JSON.stringify({ level: "info", msg: "recurring task deferred", job: name, ...result, resources: sample }));
  }
  return result;
}

export function resourceCron(name: string, original: string): string {
  if (!balancedResources()) return original;
  const stagger: Record<string, string> = {
    "content.sweep": "*/2 * * * *",
    // Odd minutes avoid the even-minute safety sweep; previously every other translation collided.
    "content.translate": "1-59/4 * * * *",
    "hot.rank": "3-59/5 * * * *",
    "ops.recover": "2-59/10 * * * *",
    "ops.alerts": "4-59/10 * * * *",
    "feedback.forward": "6-59/10 * * * *",
    "sources.reserves": "7-59/10 * * * *",
    "sources.mp-reconcile": "8-59/15 * * * *",
  };
  return stagger[name] ?? original;
}
