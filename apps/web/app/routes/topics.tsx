import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/topics";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/topics";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  // 接口的 5xx 走 loadOr404 的约定（503 + 不缓存），别让一次读不到变成页面 500。
  return loadOr404<{ topics: TopicSummary[]; groups: Array<{ key: string; name: string; blurb: string }> }>("/api/site/topics", { signal: request.signal });
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({ title: c.metaTitle, description: c.metaDescription, path: "/topics", image: "/og/pages/topics.png", locale });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export default function TopicsPage() {
  const { topics, groups } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  // 引导语拆成前后两段，中间那段是主题数——主题随行业包增减，由数据自己数（这句曾写死 45，
  // 加一个主题就过期）；数字套上 `.num`（等宽、可对齐）。分组名是词表里的动态内容，保持中文，
  // 页面只用字典里的连接符把名字拼成串。
  const groupsJoined = groups.map((g) => g.name).join(c.groupJoiner);
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{c.heading}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          {c.leadPre(groupsJoined)}
          <span className="num">{topics.length}</span>
          {c.leadPost(groupsJoined)}
        </p>
      </header>
      {/* 英文页的一行说明：分组名、主题词与释义仍是词表里的中文——这一页只有主题卡，没有条目行，
          不说「标题按原语种显示」那种在这里没有对应物的话。中文页渲染为空。 */}
      {locale === "en" && <p className={`text-[12.5px] text-ink-4 mt-1`}>{c.chineseNotice}</p>}
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          {/* 宽屏（≥1536）从四列到五列：45 张卡在 1440 上要滚 11 行，多一列不藏任何信息、只是把空出来的右侧用上。 */}
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={localeAppPath(`/topics/${t.slug}`, locale)}
                    prefetch="intent"
                    aria-label={c.cardAria(t.name)}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      {c.cardCta(String(t.total))} <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
