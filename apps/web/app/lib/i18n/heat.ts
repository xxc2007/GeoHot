// 事件页热度走势图（features/story/HeatChart.tsx）的界面词表。图的坐标与数据不进字典——只翻网站
// 自己印的句子：标题行、读屏说明、坐标轴日期（日期写法走 lib/format 的 locale 参数）、提示框与脚注。
// 字典形状与 shell.ts 一致：`en: typeof zh` 把两份键锁住；中文输出与 i18n 之前逐字相同。
const zh = {
  /** 观测小时不足三个、画不出图时的那一句。 */
  noData: "还没有足够的连续观测数据，暂不绘制趋势。",
  /** 标题行三段：当前、峰值（括号里是峰值时刻）与 24 小时变化。 */
  current: "当前热度",
  peak: "可比范围峰值",
  /** 峰值时刻的括号跟着语言走：中文全角（），英文半角 ( )。 */
  peakDate: (when: string) => `（${when}）`,
  change: "近 24 小时可比范围变化",
  /** 图表的读屏提示（aria-describedby）与组名（aria-label，带运行时数字）。 */
  hint: "这张热度走势图可以用键盘操作：左右方向键逐点查看，Esc 退出。",
  chartAria: (current: number, peak: number) => `热度走势：当前 ${current}，峰值 ${peak}`,
  /** 提示框：热度值与参与者数（数字由页面用 `<span class="num">` 包好）。 */
  heat: "热度",
  participantsPost: " 位参与者",
  /** 图下脚注：口径说明与两种操作方式。 */
  footnote: "趋势仅比较持续完整观测到的相同主体，范围可能小于当前热度统计。移动指针或点击图表查看每小时热度；键盘可用左右方向键切换。",
};

const en: typeof zh = {
  noData: "Not enough continuous observations yet to draw a trend.",
  current: "Current heat",
  peak: "Peak in comparable range",
  peakDate: (when) => ` (${when})`,
  change: "Change over the last 24 hours",
  hint: "This heat chart works with the keyboard: the left and right arrow keys step through the points, Esc exits.",
  chartAria: (current, peak) => `Heat trend: currently ${current}, peak ${peak}`,
  heat: "Heat",
  participantsPost: " participants",
  footnote: "The trend compares only the same subject over fully observed hours, so its range can be narrower than the current heat figure. Hover over or tap the chart for hourly heat; the arrow keys work as well.",
};

export const copy = { zh, en } as const;
