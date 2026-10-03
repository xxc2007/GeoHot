// Both long-running processes register this at start-up.
//
// Node 24 treats an unhandled rejection as fatal, so the only question is what the operator gets to
// read: a bare stack across two stderr lines in the journal, or one JSON record naming the component
// and the reason. Exiting is still correct — after an exception the process state is unknown, and
// pg-boss will deliver the job again to a fresh worker.
import { closeDb } from "../db.ts";

export function guardProcessExit(component: string): void {
  const report = (kind: "unhandledRejection" | "uncaughtException") => (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({ level: "fatal", component, kind, message: err.message, stack: err.stack?.split("\n").slice(0, 8).join(" | ") }));
    // Give the log line a chance to leave the pipe, then close the pool and go. systemd restarts us.
    setTimeout(() => process.exit(1), 500);
    void closeDb().catch(() => {}).finally(() => process.exit(1));
  };
  process.on("unhandledRejection", report("unhandledRejection"));
  process.on("uncaughtException", report("uncaughtException"));
}
