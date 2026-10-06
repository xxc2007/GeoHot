// 站内「来路」折成去处。一条规则一个写法：`routes/item.tsx` 与 `routes/story.tsx` 各写过一份，
// 认得的页面不一样（`/more`、`/leaderboard`、`/story/:id` 只在其中一份里），同一个 ?from= 在两个页面上
// 会得到不同的返回链接。
import { appPath } from "./public-path";

const PLACES: Array<readonly [RegExp, string]> = [
  [/^\/$/, "精选"],
  [/^\/all$/, "全部动态"],
  [/^\/hot$/, "热点榜"],
  [/^\/starred$/, "收藏"],
  [/^\/topics$/, "主题"],
  [/^\/topics\/[^/]+$/, "主题页"],
  [/^\/story\/[^/]+$/, "事件页"],
  [/^\/daily(\/|$)/, "日报"],
  [/^\/weekly(\/|$)/, "周报"],
  [/^\/monthly(\/|$)/, "月报"],
  [/^\/leaderboard(\/|$)/, "榜单"],
  [/^\/about$/, "关于"],
  [/^\/changelog$/, "更新日志"],
  [/^\/more$/, "更多"],
];

/**
 * 把一个「来路」值折成一个去处和它的名字。值必须是站内绝对路径（`//host` 是协议相对的站外地址，
 * 挡掉），并且先过 `appPath()` 剥掉部署前缀——`/geohot/all` 认成 `/all`，否则子路径部署下这条链接
 * 会跳到同域名上的另一个站（`docs/known-issues.md`「子路径链接退化」）。查询串原样保留，所以从
 * `/all?tag=…` 进来就回到那个筛选结果，不是回到裸 `/all`。
 */
export function backPlace(value: string | null): { name: string; to: string } | null {
  if (!value?.startsWith("/") || value.startsWith("//")) return null;
  const cut = value.indexOf("?");
  const pathname = appPath(cut < 0 ? value : value.slice(0, cut)).replace(/(.)\/+$/, "$1");
  const hit = PLACES.find(([re]) => re.test(pathname));
  return hit ? { name: hit[1], to: cut < 0 ? pathname : `${pathname}${value.slice(cut)}` } : null;
}
