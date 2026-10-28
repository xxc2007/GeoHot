import { readFileSync, statfsSync } from "node:fs";
import { availableParallelism } from "node:os";

/** Opt-in for the small production host; local configuration and ordinary workers keep their policy. */
export function balancedResources(): boolean {
  const value = process.env.GEOHOT_RESOURCE_PROFILE;
  if (value && value !== "balanced") throw new Error("GEOHOT_RESOURCE_PROFILE must be balanced or unset");
  return value === "balanced";
}

/** Prioritise fresh work without changing publication dates or the historical-content boundary. */
export function realTimePriority(input: { historical: boolean; archive: boolean; signal: boolean; observedAt: number }, now = Date.now()): number {
  if (input.historical) return input.archive ? -1 : -2;
  if (!balancedResources()) return input.signal ? -1 : 0;
  // A minute-based key keeps newer arrivals ahead even when an old job has waited long enough
  // to cross an age band. Historical work retains its negative priority and remains queued.
  const minute = Number.isFinite(input.observedAt) ? Math.floor(Math.min(input.observedAt, now) / 60_000) : 0;
  const priority = Math.min(2_147_483_646, Math.max(20, minute * 2));
  return priority - (input.signal ? 1 : 0);
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

export function resourcePressured(sample: ResourceSample): boolean {
  return !Object.values(sample).every(Number.isFinite) || sample.availableMiB < 64 || sample.memoryFull >= 20 || sample.ioFull >= 50
    || sample.cpuSome >= 75 || sample.loadPerCpu >= 2 || sample.diskFreeMiB < 2048;
}

/** Check between repeatable scan items; never interrupts an in-flight paid call. */
export function resourceHeadroom(): boolean {
  if (!balancedResources()) return true;
  try { const s = readResourceSample(); return !resourcePressured(s) && s.availableMiB >= 80 && s.memoryFull < 15 && s.ioFull < 40; } catch { return false; }
}

export function scheduledResourcePressured(sample: ResourceSample): boolean {
  return resourcePressured(sample) || sample.availableMiB < 80 || sample.memoryFull >= 15 || sample.ioFull >= 40;
}

// Only repeatable scans are deferred. Their article/source work stays in PostgreSQL and the next
// cron occurrence revisits it. Never use this policy to complete a claimed article job without work,
// or to discard a daily/weekly/monthly report, backup, recovery or operator request.
const REPEATABLE = new Set([
  "content.sweep", "content.translate", "sources.reserves", "sources.mp-reconcile",
  "hot.rank", "hot.snapshot", "stories.status", "stories.links", "reports.catch-up",
]);

export class ResourceBudget {
  private healthySince: number | undefined;
  private paused = true;
  private busy = false;

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
    if (this.busy) return { deferred: true, reason: "recurring-task-slot-busy" };
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
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
