// Both long-running processes register this at start-up.
//
// Node 24 treats an unhandled rejection as fatal, so the only question is what the operator gets to
// read: a bare stack across two stderr lines in the journal, or one JSON record naming the component
// and the reason. Exiting is still correct — after an exception the process state is unknown, and
// pg-boss will deliver the job again to a fresh worker.
import { closeDb } from "../db.ts";

export function guardProcessExit(component: string): void {
  // 只走一个出口：先让日志离开管道（500ms），但 closeDb 更快时也不要插队 exit；
  // 连续异常只处理第一次，避免叠出一堆互相打断的 timer。
  let exiting = false;
  const report = (kind: "unhandledRejection" | "uncaughtException") => (error: unknown) => {
    if (exiting) return;
    exiting = true;
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(JSON.stringify({ level: "fatal", component, kind, message: err.message, stack: err.stack?.split("\n").slice(0, 8).join(" | ") }));
    // Give the log line a chance to leave the pipe, then close the pool and go. systemd restarts us.
    const timer = setTimeout(() => process.exit(1), 500);
    void closeDb().catch(() => {}).finally(() => {
      clearTimeout(timer);
      process.exit(1);
    });
  };
  process.on("unhandledRejection", report("unhandledRejection"));
  process.on("uncaughtException", report("uncaughtException"));
}
