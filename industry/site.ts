// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "GEOHOT",
  /**
   * 行业词：拼进默认说法里，比如“地理日报”“全部地理动态”。
   * 中文词直接连着写，只有以英文字母或数字结尾时才加一个空格（见下面的 withSubject）。
   */
  subject: "地理",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "GEOHOT 地理热点 — 地理动态精选与每日日报",
  /**
   * 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。
   * 分享卡片只排得下大约 78 个字，这里留出余量。
   */
  description: "盯住台站、卫星机构、统计与规划部门、期刊和研究者的信源，先预筛再按空间显著性打两次分，把同一件事的多方报道并成一个事件，写成中文标题与摘要，每天早上出一份日报。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "值得关注的地理动态",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /**
   * 默认域名，只在没设置 SITE_URL 时使用。本地跑就是 localhost:3000；
   * 上线时把占位域名 geohot.local 换成真实域名，写进环境变量 SITE_URL，不要改这里。
   */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 geohot_get_latest、geohot_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "geohot",
  /**
   * 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。
   * TODO（站长）：这是按 geohot.local 编的占位地址，上线前换成编辑部真正收信的邮箱；
   * 换之前别对外部署，security.txt 会直接把它公开。
   */
  contactEmail: "editor@geohot.local" as string | null,
  /** 页脚的一行小字（选填）。 */
  footerNote: "基于开源的热点聚合框架搭建",
  /**
   * 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。
   * TODO（站长）：备案号只能由主办者本人申请后填写，这里留空字符串，页面就不显示，不要编造。
   */
  icp: "" as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "GEOHOT",
    /**
     * 创始人（选填）：{ name, url, description }。
     * 站长本人愿意署名时把 name 换成真名、url 换成他本人的主页；
     * 没有真名之前就用编辑部，不要替站点编一个人名（这段会进 schema.org 的 founder）。
     */
    founder: { name: "地理热点编辑部" } as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "GEOHOTBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["关于这片土地的消息每天都有，", "有依据、值得写的，只有几条。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 替你盯着 {sources} 个地理信源：抓取、归并、打分、精选，按空间显著性决定谁能进当天的日报，每天早上 8 点出一份日报。免费，不用注册。`,
  /** 信源河动画下面的四个环节（栏目标题固定在页面里：采集 / 收录 / 精选 / 成刊）。 */
  steps: {
    collect: "台站与卫星机构报的地震、台风、洪水，统计与区划部门给的人口和边界数字，地理学期刊的研究，做区域研究和野外考察的人写的长文；活跃的源 15 分钟就看一次。",
    store: "抓到的都存下来，同一场地震、同一份数据的多家报道并成一个事件；只计入热度的账号也算在内。热度看的是有几家独立来源在写同一件事，48 小时的窗口、24 小时降一半，热点榜由此算出。",
    /* 这里只描述站点真正执行的关口（预筛 + 两次独立打分 + 门槛），不宣称是谁或什么在执行打分：
       换成人工策划、换成真实模型，这几句都仍然成立。别在这里加「AI 自动生成」一类说法。 */
    select: "先看是不是地理的事、有没有实在信息；过了再按空间显著性打两次分（0-100），两次之和过门槛才入选——影响尺度大、多家独立报道、有数据或图件影像支撑的才排得靠前。这套标准和把它挡在外面的规则（旅游软文、研学招生、景区通稿）都是编辑部写定的。",
    publish: "每天 08:00 出当天的日报，周一出周报，每月 1 日出月报；条目按热度排，每条都留着原文地址，方便你回去核对。精选的几条可以推到飞书群。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatarSourceId：一个 X 账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   * TODO（站长）：下面的自我介绍按编辑部写的，如果改成个人署名，记得和页面里“做这个站的人”的说法对齐；
   * wechat / feishu 两个卡片没有真实渠道就先不写。
   */
  maker: {
    name: "地理热点编辑部",
    greeting: [
      "这里每天收一遍地理相关的动静：哪家台站发了数据，哪条河的走向有了新说法，哪份规划落到哪一片地方。",
      "能被写进来的，得说清发生在哪儿、影响多大、是谁先报的，最好还有图、有数。原文都在每条下面留着，重要数字请回原文看一眼。",
    ],
    avatarSourceId: null as string | null,
  } as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要和阅读索引，原文版权归各台站、机构、期刊和媒体所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “地理日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}
