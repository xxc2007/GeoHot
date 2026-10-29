// Immediate process-local overlay on the durable ledger health snapshot. No receipts are changed.
const QUOTA = /free-models-per-day|insufficient_quota|exceeded your current quota|FreeTierError|今日文本额度已用完|额度已用尽|购买加量包/i;
const HOUR = 3600_000;

export class ModelCooldown {
  private readonly until = new Map<string, { until: number; generation: number }>();
  private generation = 0;
  begin(): number { return this.generation; }
  reject(service: string, model: string, status: number, message: string, now = Date.now()): void {
    if (status === 401 || status === 403 || status >= 400 && status < 600 && QUOTA.test(message)) {
      this.until.set(`${service}|${model}`, { until: now + HOUR, generation: ++this.generation });
    }
  }
  accept(service: string, model: string, ticket: number): void {
    const key = `${service}|${model}`, refusal = this.until.get(key);
    // Compare process order, not wall-clock milliseconds: old in-flight successes cannot erase new refusals.
    if (refusal !== undefined && ticket >= refusal.generation) this.until.delete(key);
  }
  overlay(durable: ReadonlySet<string>, now = Date.now()): Set<string> {
    const result = new Set(durable);
    for (const [key, refusal] of this.until) {
      if (now < refusal.until) result.add(key);
      else this.until.delete(key);
    }
    return result;
  }
}

export const modelCooldown = new ModelCooldown();
