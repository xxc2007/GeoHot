import type { PgBoss, Db } from "pg-boss";
import { BacklogShare } from "./backlog-share.ts";
import { balancedResources, readResourceSample, resourcePressured, observeScheduledResources, scheduledResourcePressured, type ResourceSample } from "./resource-budget.ts";

const CONTROLLED = new Set([
  "content.analyze", "content.extract-body", "events.group", "events.digest", "sources.fetch", "sources.fetch-x",
  "sources.mp", "media.prepare", "publication.republish-source", "cron.content.translate",
]);
const FETCH_LANE = new Set(["sources.fetch", "sources.fetch-x", "sources.mp"]);
const INITIAL_ORDER = ["media.prepare", "events.digest", "events.group", "cron.content.translate", "sources.fetch", "content.extract-body", "sources.fetch-x", "sources.mp"];
const OFFER_TTL_MS = 15_000;
const EMPTY_TTL_MS = 10_000;
// Longer than a 5 s poll plus scheduler jitter: a fast poller must not expire a slow poller's
// reserved turn just before it arrives. Still bounded below the 15 s offer lifetime.
const TURN_WAIT_MS = 12_000;
const SHORT_BURST_MS = 10_000;
const SHORT_BURST_JOBS = 3;
const intakeLane = (name: string, combined: boolean) => FETCH_LANE.has(name) || combined && name === "content.extract-body" ? "fetch" : combined && name === "content.analyze" ? "analysis" : "processing";
const shortKind = (name: string, combined: boolean): "fetch" | "media" | undefined => intakeLane(name, combined) === "fetch" ? "fetch" : name === "media.prepare" ? "media" : undefined;

/** Candidate lanes from the same local WIP snapshot used by the unchanged hard active limit. */
export function intakeAvailableLanes(work: Array<{ name: string; count: number }>, combined: boolean, combinedLimit = 3): ReadonlySet<string> {
  const controlled = work.filter(w => CONTROLLED.has(w.name));
  if (controlled.reduce((n, w) => n + w.count, 0) >= (combined ? combinedLimit : 2)) return new Set();
  const occupied = new Set(controlled.filter(w => w.count > 0).map(w => intakeLane(w.name, combined)));
  return new Set([...CONTROLLED].map(name => intakeLane(name, combined)).filter(lane => !occupied.has(lane)));
}

export function intakeActive(queue: string, work: Array<{ name: string; count: number }>, combined: boolean, combinedLimit = 3): number {
  const controlled = work.filter(w => CONTROLLED.has(w.name));
  // Extraction is network/body I/O. In the combined runtime it shares collection's slot rather
  // than waiting behind a multi-minute grouping call; the same total of three remains enforced.
  const kind = (name: string) => intakeLane(name, combined);
  const total = controlled.reduce((n, w) => n + w.count, 0);
  const lane = controlled.filter(w => kind(w.name) === kind(queue)).reduce((n, w) => n + w.count, 0);
  return total >= (combined ? combinedLimit : 2) || lane >= 1 ? 1 : 0;
}

// pg-boss's public Db adapter is wrapped before start. Only its dequeue statement is admitted here;
// completion, receipt persistence, enqueue, maintenance and critical cron work always reach the DB.
// This shape is checked against the installed pg-boss SQL generator in resource-intake.test.ts.
export function intakeQueue(text: string): string | null {
  if (!/^\s*WITH\b/i.test(text) || !/UPDATE\s+pgboss\.\w+\s+j\s+SET\s+state\s*=\s*'active'\s*,\s*started_on\s*=/i.test(text)) return null;
  const queue = /WHERE\s+name\s*=\s*'([\w.-]+)'/i.exec(text)?.[1];
  if (!queue) throw new Error("Unrecognised pg-boss claim statement: resource admission needs review");
  return CONTROLLED.has(queue) ? queue : null;
}

export class IntakeBudget {
  private paused = true;
  private healthySince: number | undefined;
  private claiming = false;
  private nextClaim = -Infinity;
  private readonly offers = new Map<string, { seen: number; emptyUntil: number }>();
  private readonly served = new Map<string, number>();
  private readonly waiting = new Map<string, { queue: string; since: number }>();
  private shortBurst: { kind: "fetch" | "media"; until: number; remaining: number } | undefined;
  private readonly burstArmed = { fetch: true, media: true };

  private readonly combined: boolean;
  private readonly backlogShare = new BacklogShare();
  constructor(combined = false) { this.combined = combined; }

  /** Polling is demand, even while a lane is occupied. Fast pollers cannot buy more turns. */
  private turn(queue: string, now: number, availableLanes?: ReadonlySet<string>): boolean {
    const lane = intakeLane(queue, this.combined);
    const scope = availableLanes ? "all-eligible-lanes" : lane;
    if (availableLanes && !availableLanes.has(lane)) return false;
    if ((this.offers.get(queue)?.emptyUntil ?? 0) > now) return false;
    if (this.shortBurst && now >= this.shortBurst.until) this.shortBurst = undefined;
    let held = this.waiting.get(scope);
    if (held && availableLanes && !availableLanes.has(intakeLane(held.queue, this.combined))) {
      this.waiting.delete(scope); held = undefined;
    }
    // A stopped/unresponsive poller cannot reserve an idle lane beyond the bounded grace period.
    if (held && held.queue !== queue && now - held.since >= TURN_WAIT_MS) {
      this.offers.delete(held.queue);
      this.waiting.delete(scope);
      return true;
    }
    const contenders = [...this.offers].filter(([name, offer]) => (availableLanes ? availableLanes.has(intakeLane(name, this.combined)) : intakeLane(name, this.combined) === lane)
      && now - offer.seen <= OFFER_TTL_MS && offer.emptyUntil <= now).map(([name]) => name);
    contenders.sort((a, b) => {
      const sa = this.served.get(a) ?? -Infinity, sb = this.served.get(b) ?? -Infinity;
      if (sa !== sb) return sa - sb;
      const rank = (name: string) => { const i = INITIAL_ORDER.indexOf(name); return i < 0 ? INITIAL_ORDER.length : i; };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    // Amortise a fair short-work turn without opening another slot. Fetch queues retain their
    // LRS order; media preference never includes grouping, digesting or translation. Only one
    // bounded burst exists, and an occupied/empty short-work lane cannot reserve other lanes.
    const burstQueue = this.shortBurst ? contenders.find(name => shortKind(name, this.combined) === this.shortBurst!.kind) : undefined;
    if (this.shortBurst && !burstQueue) this.shortBurst = undefined;
    const preferred = burstQueue ?? contenders[0];
    if (preferred && preferred !== queue) {
      if (held?.queue !== preferred) this.waiting.set(scope, { queue: preferred, since: now });
      return false;
    }
    this.waiting.delete(scope);
    return true;
  }

  async execute(db: Db["executeSql"], text: string, values: unknown[] | undefined, sample: ResourceSample,
    now: number, active: number, availableLanes?: ReadonlySet<string>): ReturnType<Db["executeSql"]> {
    const queue = intakeQueue(text);
    if (!queue) return db(text, values);
    const prior = this.offers.get(queue);
    this.offers.set(queue, { seen: now, emptyUntil: prior?.emptyUntil ?? 0 });
    if (resourcePressured(sample)) { this.paused = true; this.healthySince = undefined; this.shortBurst = undefined; }
    if (this.paused) {
      const recovered = Object.values(sample).every(Number.isFinite) && sample.availableMiB >= 80 && sample.memoryFull < 10
        && sample.ioFull < 30 && sample.cpuSome < 50 && sample.loadPerCpu < 1.5 && sample.diskFreeMiB >= 3072;
      if (!recovered) this.healthySince = undefined;
      else this.healthySince ??= now;
      if (this.healthySince !== undefined && now - this.healthySince >= 15_000) this.paused = false;
    }
    // A translation which the scan policy cannot run must remain queued, not be claimed and
    // completed as "deferred" for another four minutes. It cannot reserve a turn while ineligible.
    if (queue === "cron.content.translate" && scheduledResourcePressured(sample)) {
      this.offers.delete(queue);
      return { rows: [] };
    }
    // No claim is sent to PostgreSQL on a hold: jobs keep their original state, priority, lease and
    // retry count. A paid call already active is allowed to finish and persist its receipt.
    if (this.paused || this.claiming || active >= 1 || now < this.nextClaim) return { rows: [] };
    if (!this.turn(queue, now, availableLanes)) return { rows: [] };
    this.claiming = true;
    try {
      const result = this.combined ? await this.backlogShare.execute(db, queue, text, values, now) : await db(text, values);
      // An empty DB response also consumed this queue's turn; otherwise the never-served empty
      // queue would win every cooldown expiry ahead of a genuinely busy queue.
      this.served.set(queue, now);
      if (result.rows.length) {
        this.nextClaim = now + 1000;
        this.offers.set(queue, { seen: now, emptyUntil: 0 });
        const kind = shortKind(queue, this.combined);
        if (intakeLane(queue, this.combined) !== "fetch") this.burstArmed.fetch = true;
        if (queue !== "media.prepare") this.burstArmed.media = true;
        if (this.shortBurst && kind === this.shortBurst.kind && now < this.shortBurst.until) {
          this.shortBurst.remaining -= 1;
          if (this.shortBurst.remaining <= 0) this.shortBurst = undefined;
        } else {
          this.shortBurst = undefined;
          if (kind && this.burstArmed[kind]) {
            this.shortBurst = { kind, until: now + SHORT_BURST_MS, remaining: SHORT_BURST_JOBS - 1 };
            this.burstArmed[kind] = false;
          }
        }
      } else {
        this.offers.set(queue, { seen: now, emptyUntil: now + EMPTY_TTL_MS });
        if (shortKind(queue, this.combined)) this.shortBurst = undefined;
      }
      return result;
    } finally { this.claiming = false; }
  }
}

export function installResourceIntake(boss: PgBoss) {
  if (!balancedResources()) return;
  const adapter = boss.getDb();
  const execute = adapter.executeSql.bind(adapter);
  const budget = new IntakeBudget(process.env.WORKER_ROLE === "all");
  let cachedAt = -Infinity;
  let sample: ResourceSample;
  let lastLog = -Infinity;
  let lastGrantLog = -Infinity;
  adapter.executeSql = async (text, values) => {
    const queue = intakeQueue(text);
    if (!queue) return execute(text, values);
    const now = Date.now();
    if (now - cachedAt >= 1000) {
      try { sample = readResourceSample(); } catch {
        sample = { availableMiB: NaN, memoryFull: NaN, ioFull: NaN, cpuSome: NaN, diskFreeMiB: NaN, loadPerCpu: NaN };
      }
      cachedAt = now;
      observeScheduledResources(sample, now);
    }
    // Two controlled jobs under constrained headroom; retain three only with ample memory and low I/O pressure.
    const combinedLimit = sample.availableMiB >= 160 && sample.memoryFull < 5 && sample.ioFull < 15 ? 3 : 2;
    const work = boss.getWipData();
    const combined = process.env.WORKER_ROLE === "all";
    const active = intakeActive(queue, work, combined, combinedLimit);
    const availableLanes = intakeAvailableLanes(work, combined, combinedLimit);
    const result = await budget.execute(execute, text, values, sample, now, active, availableLanes);
    if (result.rows.length && now - lastGrantLog >= 5000) {
      console.log(JSON.stringify({ level: "info", msg: "background queue admitted", queue,
        lane: intakeLane(queue, process.env.WORKER_ROLE === "all") }));
      lastGrantLog = now;
    }
    if (resourcePressured(sample) && now - lastLog >= 60_000) {
      console.log(JSON.stringify({ level: "info", msg: "background queue intake held for resource pressure", resources: sample, active }));
      lastLog = now;
    }
    return result;
  };
}
