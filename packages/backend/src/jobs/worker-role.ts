// Pure startup policy, shared by the queue client and the worker entrypoint. No database imports.
export type WorkerRole = "all" | "coordinator" | "content-executor";

export function workerPlan(raw: string | undefined = process.env.WORKER_ROLE) {
  const role = raw?.trim() || "all";
  if (role !== "all" && role !== "coordinator" && role !== "content-executor") {
    throw new Error("WORKER_ROLE must be all, coordinator or content-executor");
  }
  return {
    role: role as WorkerRole,
    content: role !== "coordinator",
    extraction: role !== "coordinator",
    coordinator: role !== "content-executor",
    heartbeat: role === "content-executor" ? "content-executor" : "worker",
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
  return role === "content-executor"
    ? { max, application_name: "aihot-jobs-content-executor", schedule: false, supervise: false, migrate: false, createSchema: false }
    : { max, application_name: "aihot-jobs" };
}
