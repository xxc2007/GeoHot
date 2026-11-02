// Immediate process-local overlay on the durable ledger health snapshot. No receipts are changed.
// 2026-11-02 生产实测（receipt_attempts 2h 37 次全失败）：autoclaw-cn 的 429 文案是「GLM-5.3 免费额度
// 已用完,开通连续包月会员继续使用」——旧 matcher 只认「额度已用尽」（尽），不认「已用完」（完），
// 这扇门就永远进不了一小时冷却，每次轮转都白烧一次调用。
const QUOTA = /free-models-per-day|insufficient_quota|exceeded your current quota|FreeTierError|今日文本额度已用完|额度已用[尽完]|购买加量包/i;
// 确定性配置拒绝，与 readSick 的 config_refusal（models.ts）同一口径：成员被上游停用（HTTP 404
// "switched off in Magpie"，minimax-code-global 实测形态）或因稳定的参数原因被拒（HTTP 400 code
// 11150 "reasoning effort value is not supported by the current model"，workbuddy-cn 实测形态）。
// 这两类错误换个时刻必然复现——2026-10-30~31 它们在 24h 内烧掉约 985 条 translate_body 收据失败，
// 此前只有 10 分钟失败率窗在管，窗口一过期就复烧。与 quota/auth 同权：命中即冷却一小时。
const CONFIG = /switched off in Magpie|is not supported by the current model/i;
const HOUR = 3600_000;

export class ModelCooldown {
  private readonly until = new Map<string, { until: number; generation: number }>();
  private generation = 0;
  begin(): number { return this.generation; }
  reject(service: string, model: string, status: number, message: string, now = Date.now()): void {
    if (status === 401 || status === 403 || status >= 400 && status < 600 && (QUOTA.test(message) || CONFIG.test(message))) {
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
