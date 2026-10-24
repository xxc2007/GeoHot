/** Keep diagnostic transport codes, never copy URLs or credentials from nested errors. */
export function sourceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codes = new Set<string>();
  let cause: unknown = error;
  for (let i=0;i<4 && cause && typeof cause === "object";i++) {
    const value = cause as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && /^[A-Z0-9_]{1,60}$/.test(value.code)) codes.add(value.code);
    cause = value.cause;
  }
  return `${message}${codes.size ? ` [${[...codes].join(" / ")}]` : ""}`.slice(0,1000);
}
