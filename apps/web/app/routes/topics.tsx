import { Link, useLoaderData } from "react-router";
import { TOPICS_PAGE } from "@aihot/industry/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

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

export function meta() {
  // 数不写死：主题随行业包增减，页面上那句「共 N 个方向」由数据自己数（这句曾写死 45，加一个主题就过期）。
  // 文案本身在 industry/site.ts（TOPICS_PAGE），分组名与说明在 industry/topics.json——页面不再自带一份。
  return pageMeta({ title: TOPICS_PAGE.metaTitle, description: TOPICS_PAGE.metaDescription, path: "/topics", image: "/og/pages/topics.png" });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export default function TopicsPage() {
  const { topics, groups } = useLoaderData<typeof loader>();
  // 模板里恰好一个 {count}：拆开只为把数字套上 `.num`（等宽、可对齐），文案本身仍在 industry/site.ts。
  const [leadBefore, leadAfter = ""] = TOPICS_PAGE.lead.replace("{groups}", groups.map((g) => g.name).join("、")).split("{count}");
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{TOPICS_PAGE.heading}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          {leadBefore}
          <span className="num">{topics.length}</span>
          {leadAfter}
        </p>
      </header>
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
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      查看 {t.total} 条精选 <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
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
