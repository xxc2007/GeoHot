// 后台模型页：把冷却条目映射为运维可操作的状态标签。
// 不回显上游原文（body 可能带凭据/内部信息），只展示分类、证据时间与恢复条件。

export type CooldownCategory = "quota_day" | "rate_minute" | "auth" | "config";

export interface CooldownEntry {
  key: string;
  service: string;
  model: string;
  category: CooldownCategory;
  evidenceAt: number;      // epoch ms
  until: number;           // epoch ms
  resetAt: number | null; // 上游明确给出的恢复时间；null=无证据
  resetAssumed: boolean;   // true=until 是我们保守默认的，不是上游给的
}

export type CooldownState =
  | "available"        // 未在冷却列表里
  | "rate_limited"    // 分钟限流
  | "quota_day"       // 日额度耗尽（无明确 reset）
  | "pending_reset"    // 日额度耗尽，等上游 reset 时间戳
  | "auth"            // 认证失败 / 账号停用
  | "config"         // 配置拒绝（参数不支持 / 上游停用 / 渠道拒认）
  | "temp_failure";  // 临时故障（由失败率派生，不自动重试）

export interface CooldownDisplay {
  state: CooldownState;
  label: string;
  tone: "bad" | "warn" | "muted";
  /** 运维可操作的恢复条件说明。 */
  recovery: string;
}

export function displayCooldown(e: CooldownEntry, now: number = Date.now()): CooldownDisplay {
  switch (e.category) {
    case "rate_minute":
      return {
        state: "rate_limited",
        label: "分钟限流",
        tone: "warn",
        recovery: `约 ${Math.max(1, Math.round((e.until - now) / 1000))} 秒后自动恢复；无需人工介入。`,
      };
    case "quota_day":
      if (e.resetAt) {
        return {
          state: "pending_reset",
          label: "日额度耗尽 · 待重置",
          tone: "bad",
          recovery: `上游重置时间 ${new Date(e.resetAt).toLocaleString("zh-CN")}；重置后需一次真实成功调用才宣布恢复。`,
        };
      }
      return {
        state: "quota_day",
        label: "日额度耗尽",
        tone: "bad",
        recovery: `保守冷却至 ${new Date(e.until).toLocaleString("zh-CN")}（未拿到上游 reset 时间）；到期后由真实调用验证恢复。`,
      };
    case "auth":
      return {
        state: "auth",
        label: "认证失败 / 账号停用",
        tone: "bad",
        recovery: `冷却至 ${new Date(e.until).toLocaleString("zh-CN")}；需检查凭据或账号状态，期间由其他健康成员顶上。`,
      };
    case "config":
      return {
        state: "config",
        label: "配置拒绝",
        tone: "warn",
        recovery: `冷却至 ${new Date(e.until).toLocaleString("zh-CN")}；参数/模型已被上游停用，需改配置或切门。`,
      };
  }
}

/** 把 epoch ms 格式化为后台友好的短时间。 */
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 计算距离恢复的剩余秒数（负数表示已过期）。 */
export function secondsUntil(until: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((until - now) / 1000));
}
