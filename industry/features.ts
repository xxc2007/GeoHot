// 可选模块。它们只对 AI 行业有意义：做别的行业时两项都设为 false，或者按 docs/customize.md 整块删掉。
// 关掉以后：导航里不再出现入口，对应的定时任务不再运行，页面与接口返回 404。
// 本站两项都关（简报决定 2.5：模型榜与 Codex 重置监控都是 AI 专属模块，地理站无意义）。
// 关以后 seed 不再导入模型目录；但迁移建的表不会回滚，之前开着时导入的 lb_models / lb_aliases 行仍留在库里，要手工清。

export const FEATURES = {
  /** 模型榜：汇总公开评测，按公开方法 v15 计算共识排名（/leaderboard）。每天抓 4 次评测来源。 */
  leaderboard: false,
  /** Codex 重置监控：盯 OpenAI Codex 负责人在 X 上的额度重置公告（/codex-reset）。需要 SocialData。 */
  codexResetMonitor: false,
} as const;
