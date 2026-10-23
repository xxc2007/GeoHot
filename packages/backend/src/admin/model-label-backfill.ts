/** Retry only transient database resource failures. The caller advances its durable cursor only
 * after this returns successfully; a failed transaction can never skip a batch. */
export async function retryModelLabelBatch<T>(read: (batch: number) => Promise<T>, initialBatch: number,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  report: (retry: number, batch: number, code: string) => void = () => {}) {
  let batch = initialBatch;
  for (let retries = 0; ; retries++) {
    try { return { result: await read(batch), batch }; }
    catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== "57014" && code !== "55P03") || retries >= 5) throw error;
      batch = Math.max(1, Math.floor(batch / 2));
      report(retries + 1, batch, code);
      await wait(Math.min(1000, 100 * 2 ** retries));
    }
  }
}
