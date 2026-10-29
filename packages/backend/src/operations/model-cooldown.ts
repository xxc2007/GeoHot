// Immediate process-local overlay on the durable ledger health snapshot. No receipts are changed.
const QUOTA = /free-models-per-day|insufficient_quota|exceeded your current quota|FreeTierError|今日文本额度已用完|usage exceeds frequency limit|usage limit reached|您的使用量已超出频率限制|额度已用尽|购买加量包|API 速率限制/i;
const HOUR = 3600_000;

export class ModelCooldown {
  private readonly until = new Map<string, number>();
  reject(service: string, model: string, status: number, message: string, now = Date.now()): void {
    if (status === 401 || status === 403 || status >= 400 && status < 600 && QUOTA.test(message)) {
      this.until.set(`${service}|${model}`, now + HOUR);
    }
  }
  accept(service: string, model: string, startedAt = Date.now()): void {
    const key = `${service}|${model}`, until = this.until.get(key);
    // A slow success started before the quota rejection must not reopen the newly closed member.
    if (until !== undefined && startedAt > until - HOUR) this.until.delete(key);
  }
  overlay(durable: ReadonlySet<string>, now = Date.now()): Set<string> {
    const result = new Set(durable);
    for (const [key, until] of this.until) {
      if (now < until) result.add(key);
      else this.until.delete(key);
    }
    return result;
  }
}

export const modelCooldown = new ModelCooldown();
