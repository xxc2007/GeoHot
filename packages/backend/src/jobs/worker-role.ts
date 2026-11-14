// Pure startup policy, shared by the queue client and the worker entrypoint. No database imports.
export type WorkerRole = "all" | "coordinator" | "content-executor" | "extraction-executor" | "fetcher" | "media";

export function workerPlan(raw: string | undefined = process.env.WORKER_ROLE) {
  const role = raw?.trim() || "all";
  if (role !== "all" && role !== "coordinator" && role !== "content-executor" && role !== "extraction-executor" && role !== "fetcher" && role !== "media") {
    throw new Error("WORKER_ROLE must be all, coordinator, content-executor, extraction-executor, fetcher or media");
  }
  return {
    role: role as WorkerRole,
    content: role === "all" || role === "content-executor",
    extraction: role !== "coordinator" && role !== "fetcher" && role !== "media",
    coordinator: role === "all" || role === "coordinator",
    heartbeat: role.endsWith("-executor") || role === "fetcher" || role === "media" ? role : "worker",
  };
}

/** Fail closed on a typo: a configured connection budget must never silently grow to a default. */
export function poolSize(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

export function bossOptions(role = workerPlan().role, raw: string | undefined = process.env.PGBOSS_POOL_MAX) {
  const max = poolSize(raw, "PGBOSS_POOL_MAX", 4);
  // fetcher 与 *-executor 一样是「只做自己那件事」的节点：不建表、不跑定时任务。
  return role.endsWith("-executor") || role === "fetcher" || role === "media"
    ? { max, application_name: `aihot-jobs-${role}`, schedule: false, supervise: false, migrate: false, createSchema: false }
    : { max, application_name: "aihot-jobs" };
}

/**
 * 每个角色该注册哪些作业处理器。
 *
 * 2026-11-14 事故：`apps/worker/src/main.ts` 里原来是
 *   if (plan.extraction) { … } else if (fetcher) … else if (media) … else { 采集/事件/发布/定时 }
 * 而 `plan.extraction` 对 "all" 也是 true ⇒ **协调节点（role=all）只注册了抽取作业**，
 * sources.fetch / events.group / publication / 定时任务全都没人领。
 * 症状：`sources.fetch created 784`、`events.group created 245` 一直涨，新稿入库从
 * 每小时 40 篇掉到 3 小时 20 篇，而日志里没有任何报错（作业只是没人取）。
 * 把「角色 → 注册哪些组」摘成纯函数，既能被单测钉住，也不会再被 if/else 链吃掉。
 */
export function jobGroups(raw: string | undefined = process.env.WORKER_ROLE) {
  const plan = workerPlan(raw);
  return {
    content: plan.content,
    extraction: plan.extraction,
    source: plan.role === "fetcher" || plan.coordinator,
    events: plan.coordinator,
    notify: plan.coordinator,
    publication: plan.coordinator,
    schedules: plan.coordinator,
    media: plan.role === "media",
    /** 采集节点自己就是采集；协调节点顺带把抽取也一起注册时要避免重复注册。 */
    sourceIncludesExtraction: false,
  };
}
