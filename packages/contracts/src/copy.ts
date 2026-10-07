// 「这段文字有没有中文稿」是本站被抄写得最多的一条规则：读取层用 SQL 正则，编辑器用 JS 正则，
// web 与运维脚本又各写一份。同一字符类在本仓库里曾有六份手抄写法（`items.ts` 的常量、
// `publication/detail.ts`、`editorial/translate.ts` 两处、`editorial/writing.ts` 三处、
// `apps/web/app/routes/item.tsx`、`scripts/{smoke,recompose-report,refill-copy}.ts`），
// 改一处漏两处。这一文件是唯一一处拼写它的地方，由 `tests/env-valves.test.ts` 的扫描钉住。
//
// 注意与 `editorial/writing.ts` 的 `looksZh` 区别：那条决定"生成的稿子够不够中文可以发"，
// 它还拒绝假名与谚文；这一条只决定"有没有中文稿"。两者不是同一条规则，不要合并。

/** SQL 与 JS 共用的字面量：`title ~ ${CJK_COPY_PATTERN}` 与 `hasChineseCopy(title)` 问的是同一个问题。 */
export const CJK_COPY_PATTERN = "[一-鿿]";

const CJK_COPY = new RegExp(CJK_COPY_PATTERN);
// Only ever used with `String.match`, which resets `lastIndex`; a global regex shared with `.test` would
// make alternating calls disagree with themselves.
const CJK_COPY_ALL = new RegExp(CJK_COPY_PATTERN, "g");

/** 有没有中文稿：标题里至少一个汉字。没有的条目保留自己的页面，只是不进任何列表（见读取层的中文闸门注释）。 */
export function hasChineseCopy(text: string | null | undefined): boolean {
  return typeof text === "string" && CJK_COPY.test(text);
}

/** 带前缀匹配的计数写法：`editorial/writing.ts` 判断密度与短帖长度时用的是同一个字符类。 */
export function cjkCount(text: string): number {
  return text.match(CJK_COPY_ALL)?.length ?? 0;
}

/**
 * 正文的中文判定比标题宽：声明语言优先，且声明为 `en` 时不看采样——一家英文社的稿子里引了一句
 * 中文，正文仍然是英文稿。`editorial/translate.ts` 与 `publication/detail.ts` 各自写过一份同样的
 * 表达式，这两处是同一件事。采样长度是判定的的一部分，写在这里而不是留在调用方。
 */
export function bodyIsChinese(language: string | null, sample: string): boolean {
  return language === "zh" || (hasChineseCopy(sample.slice(0, 400)) && language !== "en");
}

/** 一行以标签开头（`title_zh: …`）：模型按标签作答的形状，`editorial/writing.ts` 靠它切答复。 */
export const LABEL_PREFIX = /^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]/;

/**
 * 一整行只有标签、后面什么都没有（`title_zh:`）：空答案的形状，不是内容。
 * `editorial/writing.ts` 从 10-03 起拒收它，读取层遇到 `54eb6ac` 之前存下来的那批
 * （开发库 446 行的标题与摘要都是这句）时不再把它当标题。判定时先 trim 掉两端空白。
 */
export const LABEL_ONLY_COPY = /^\*{0,2}(?:title_zh|summary_zh|body_zh)\*{0,2}\s*[:：]\s*$/;

export function isLabelOnlyCopy(text: string | null | undefined): boolean {
  return typeof text === "string" && LABEL_ONLY_COPY.test(text.trim());
}
