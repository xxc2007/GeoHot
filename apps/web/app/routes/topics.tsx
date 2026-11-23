import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/topics";
import { loadOr404, withLang } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/topics";

interface TopicSummary {
  slug: string;
  name: string;
  nameEn?: string | null;
  group: "company" | "field" | "genre";
  definition: string;
  definitionEn?: string | null;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  const locale = localeFromPath(new URL(request.url).pathname);
  // 接口的 5xx 走 loadOr404 的约定（503 + 不缓存），别让一次读不到变成页面 500。
  // 中英字段都随包发（见 backend/publication/topics.ts 的 listTopicSummariesFor），页面按 locale 取。
  return loadOr404<{ topics: TopicSummary[]; groups: Array<{ key: string; name: string; nameEn?: string | null; blurb: string; blurbEn?: string | null }> }>(
    withLang("/api/site/topics", locale),
    { signal: request.signal },
  );
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
  // 英文页取英文字段，缺英文时如实回退中文；分组名同理（接口随包发 nameEn/blurbEn）。
  const topicName = (t: TopicSummary) => (locale === "en" ? t.nameEn ?? t.name : t.name);
  const topicDefinition = (t: TopicSummary) => (locale === "en" ? t.definitionEn ?? t.definition : t.definition);
  const groupName = (g: { name: string; nameEn?: string | null }) => (locale === "en" ? g.nameEn ?? g.name : g.name);
  const groupBlurb = (g: { blurb: string; blurbEn?: string | null }) => (locale === "en" ? g.blurbEn ?? g.blurb : g.blurb);
  const groupsJoined = groups.map(groupName).join(c.groupJoiner);
  // 只有真回退成中文的主题/分组才标注一句；全都有英文时这一页不再说「内容是中文」。
  const missingEnglish = locale === "en" && (topics.some((t) => !t.nameEn || !t.definitionEn) || groups.some((g) => !g.nameEn || !g.blurbEn));
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
      {/* 分组名、主题词与释义已按 /en 取英文字段；只有缺英文回退的那几条要说明。 */}
      {missingEnglish && <p className={`text-[12.5px] text-ink-4 mt-1`}>{c.chineseNotice}</p>}
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {groupName(g)}
            </h2>
            <p className="text-[12px] text-ink-4">{groupBlurb(g)}</p>
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
                    aria-label={c.cardAria(topicName(t))}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{topicName(t)}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{topicDefinition(t)}</span>
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
