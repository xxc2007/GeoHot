// How much of an article each door may read, step by step.
//
// 站长的硬指令（2026-10-24）：「把当前运行的这个模型接入 geohot 网站的方方面面……用最大的上下文和
// 思考强度，确保发挥最大性能」。这两扇门（`minimax-code-m3.1-flash`、`codearts-deepseek-v4.1-flash`，
// 网关目录实测 1,048,576 输入 / 524,288 输出）给的窗比站点自己会发出去的字数大一个量级，而站点在
// 两个地方把材料截断了：结构步的 `buildMaterial()` 只给 7,000 字，其余步骤的 `renderContext()` 给
// 60,000 字。**宽窗门按自己的窗读，其余门一字不变**。
//
// 两档预算，理由不同：
// - 结构步（7,000 → 60,000）：这一步定的是分类、标签与事实，7,000 字之后的正文是真的会丢信息的地方。
//   60,000 字不是新定的数——它就是写作步早就在用的那一个（`editorial/writing.ts` 的 `MAX_BODY_CHARS`），
//   所以这一步只是让结构步与写作步看同一份材料。
// - 理解步（60,000 → 120,000）：这一步产出的中文标题、提要、标签是读者直接看到的。120,000 字
//   ≈ 60k token，窗内性有实测（20 万字符 / 100,218 prompt token 一次 200：工作站 4.8 s、生产机 10.1 s），
//   连同输出 65,536 也只用掉 1,048,576 的约 12%。
//
// 不放宽的两步：预筛（PASS/BLOCK 是一道便宜的闸门，读 20 万字只为回答"要不要"不划算）与打分
// （一个注意力分数，60,000 字足够）。这些是分析输入预算，不是读者正文展示上限；
// 全文翻译采用独立的分段与完整性校验，读者端保留已完成的全文。
//
// 回滚：删掉 `BY_DOOR` 里那两行（各步退回站点默认尺度）；或把值置 0（同样退回默认值）。
/** The site's own default for the structure step: what a door without a bigger window reads. */
export const DEFAULT_MATERIAL_BODY_CHARS = 7_000;

/** The site's own default for the understanding step (the site's `MAX_BODY_CHARS`). */
export const DEFAULT_COPY_BODY_CHARS = 60_000;

/** The doors whose own window is wide enough to be worth spending on the article. */
const BY_DOOR: Record<string, { material: number; copy: number }> = {
  "minimax-code-m3.1-flash": { material: 60_000, copy: 120_000 },
  "codearts-deepseek-v4.1-flash": { material: 60_000, copy: 120_000 },
  // 2026-10-25 实测（工作站 3425 magpie 网关，`POST /v1/chat/completions`，真编辑提示词形状）：
  // 200,000 字符 → `prompt_tokens` **128,650**、2.4 s、200；400,000 字符 → **257,222**、2.6 s、200。
  // 也就是这扇门把 1,048,576 的窗真的开到了 25 万 token 以外，而站点能拿出的最长正文约 12 万字符
  // （≈6 万 token，用掉窗口约 6%）。所以给它与另外两扇宽窗门同一档：结构 60,000 / 理解 120,000。
  "qoder-cn-dfmodel": { material: 60_000, copy: 120_000 },
};

/** The structure step's body budget, by the door that will answer it. */
export function materialBodyChars(modelKey: string): number {
  return BY_DOOR[modelKey]?.material ?? DEFAULT_MATERIAL_BODY_CHARS;
}

/** The understanding step's body budget, by the door that will answer it. */
export function copyBodyChars(modelKey: string): number {
  return BY_DOOR[modelKey]?.copy ?? DEFAULT_COPY_BODY_CHARS;
}
