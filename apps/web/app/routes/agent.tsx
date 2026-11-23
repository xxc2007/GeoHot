import { useEffect, useState, type ReactNode } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { listPath, pageMeta, siteUrl } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/agent";
import { publicPath } from "../lib/public-path";
import { CodeBlock, CopyButton } from "../components/CodeBlock";
import { IconArrowUpRight, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

/** 字典里按键取文案的两张小表（订阅、端点），键集以中文为准、英文同形。 */
type FeedKey = keyof typeof copy.zh.rss.feeds;
type EndpointKey = keyof typeof copy.zh.api.endpoints;

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const MCP_VERSION = "2.0.0";
/** Counted, never written out: this page told agents about five tools while the server answered with seven. */
const TOOL_COUNT = Object.keys(T).length;
/** The machine-readable entry points, with what each one is for. 资源名是文件与协议名不译，说明在字典（copy.resources）。 */
const RESOURCES: Array<[label: string, href: string, noteKey: "llms" | "mcp" | "openapi"]> = [
  ["llms.txt", "/llms.txt", "llms"],
  ["MCP Server", "/api/mcp", "mcp"],
  ["OpenAPI 3.1", "/openapi-v1.json", "openapi"],
];

/** 接入方式的标签（MCP/RSS/REST API）不随语言变；说明与适用对象在字典（copy.tabs）。 */
const TABS = [
  { key: "mcp", label: "MCP" },
  { key: "rss", label: "RSS" },
  { key: "api", label: "REST API" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export async function loader({ request }: Route.LoaderArgs) {
  const tab = new URL(request.url).searchParams.get("tab");
  let healthy = true;
  try {
    const res = await fetch(`${process.env.API_BASE_URL || "http://127.0.0.1:3001"}/api/health`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) });
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  // The public address the examples show is the configured one, the same on the server and in the browser.
  return { tab: (TABS.some((t) => t.key === tab) ? tab : "mcp") as TabKey, healthy, base: siteUrl() };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  // Only the tab is part of the address (mcp is the default and not written).
  const path = listPath("/agent", { tab: loaderData && loaderData.tab !== "mcp" ? loaderData.tab : null });
  return pageMeta({ title: c.metaTitle, description: c.metaDescription, path, image: "/og/pages/agent.png", locale });
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24">
      <h3 className="mb-3 text-[16px] font-bold text-ink">{title}</h3>
      <div className="text-[13.5px] leading-[1.85] text-ink-2">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2"><span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" /><span>{it}</span></li>
      ))}
    </ul>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[0.88em] text-ink">{children}</code>;
}

function McpTab({ base }: { base: string }) {
  const locale = useLocale();
  const c = copy[locale];
  const url = `${base}/api/mcp`;
  const name = SITE.mcpPrefix;
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">{c.mcp.headline(String(TOOL_COUNT))}</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">{c.mcp.lead}</p>
      <div className="mt-6 flex items-center gap-2 rounded-card border border-line bg-surface p-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{url}</code>
        <CopyButton text={url} className="!text-ink-3" />
      </div>
      <CodeBlock title={c.mcp.configTitle} lang="json" code={JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2)} />
      <CodeBlock lang="bash" code={`# Claude Code\nclaude mcp add --transport http ${name} '${url}'\n# Codex\ncodex mcp add ${name} --url '${url}'`} />
      <Section title={c.mcp.toolsTitle(String(TOOL_COUNT))}>
        {/* 工具名是代码标识符，用 <Mono> 包好；连接符与说明跟在字典里。 */}
        <Bullets items={[
          <><Mono>{T.latest}</Mono>{c.mcp.toolJoiner}{c.mcp.toolLatest}</>,
          <><Mono>{T.search}</Mono>{c.mcp.toolJoiner}{c.mcp.toolSearch}</>,
          <><Mono>{T.hot}</Mono>{c.mcp.toolJoiner}{c.mcp.toolHot}</>,
          <><Mono>{T.story}</Mono>{c.mcp.toolJoiner}{c.mcp.toolStory}</>,
          <><Mono>{T.daily}</Mono>{c.mcp.toolJoiner}{c.mcp.toolDaily}</>,
          <><Mono>{T.weekly}</Mono>{c.mcp.toolJoiner}{c.mcp.toolWeekly}</>,
          <><Mono>{T.monthly}</Mono>{c.mcp.toolJoiner}{c.mcp.toolMonthly}</>,
        ]} />
        <p className="mt-4">{c.mcp.tryLead}<span className="font-medium text-ink">{c.mcp.tryCall(T.latest)}</span></p>
      </Section>
      <Section title={c.mcp.boundsTitle}>
        <Bullets items={[
          c.mcp.bound1,
          c.mcp.bound2(T.story),
          c.mcp.bound3,
        ]} />
      </Section>
    </>
  );
}

function RssTab({ base }: { base: string }) {
  const c = copy[useLocale()];
  // 订阅地址是代码常量；名称与说明按键取自字典（copy.rss.feeds）。
  const feeds: Array<[key: FeedKey, path: string]> = [
    ["selected", "/feed.xml"],
    ["full", "/feed/full.xml"],
    ["all", "/feed/all.xml"],
    ["daily", "/feed/daily.xml"],
  ];
  const categories = CATEGORY_KEYS.join("|");
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">{c.rss.headline}</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">{c.rss.lead}</p>
      <div className="mt-6 space-y-3">
        {feeds.map(([key, path]) => {
          const feed = c.rss.feeds[key];
          const url = `${base}${path}`;
          return (
            <div key={path} className="card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-semibold text-ink">{feed.name}</span>
                <CopyButton text={url} label={c.rss.copyLabel} className="!text-ink-3" />
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{feed.desc}</p>
              <code className="mt-2 block truncate font-mono text-[12.5px] text-ink-4">{url}</code>
            </div>
          );
        })}
      </div>
      <Section title={c.rss.rulesTitle}>
        {/* 末两条的地址模板是代码常量，跟在字典文案后面。 */}
        <Bullets items={[
          c.rss.rule1,
          c.rss.rule2,
          c.rss.rule3,
          <>{c.rss.rule4} <Mono>{`/feed/category/{${categories}}.xml`}</Mono></>,
          <>{c.rss.rule5} <Mono>{`/feed/full/category/{${categories}}.xml`}</Mono></>,
        ]} />
      </Section>
    </>
  );
}

function ApiTab({ base }: { base: string }) {
  const c = copy[useLocale()];
  // 端点路径是代码常量；说明按键取自字典（copy.api.endpoints）。
  const endpoints: Array<[path: string, descKey: EndpointKey]> = [
    ["/api/v1/items", "items"],
    ...(FEATURES.codexResetMonitor
      ? ([
          ["/api/v1/codex-resets/recent", "codexRecent"],
          ["/api/v1/codex-resets", "codexAll"],
        ] as Array<[string, EndpointKey]>)
      : []),
    ["/api/v1/hot-topics", "hotTopics"],
    ["/api/v1/stories/{publicId}", "story"],
    ["/api/v1/dailies", "dailies"],
    ["/api/v1/dailies/latest", "dailiesLatest"],
    ["/api/v1/dailies/{date}", "dailiesDate"],
    ["/api/v1/selected/snapshot", "snapshot"],
    ["/api/v1/selected/changes", "changes"],
  ];
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">{c.api.headline}</h2>
      {/* "以 OpenAPI 3.1 为准"一句夹着链接，拆成字典的前后两段（链接文字是协议名，不随语言变）。 */}
      <p className="mt-2 text-[14.5px] text-ink-3">{c.api.lead}{c.api.specPre}<a href={publicPath("/openapi-v1.json")} className="text-accent hover:underline">OpenAPI 3.1</a>{c.api.specPost}</p>
      <CodeBlock title={c.api.firstRequestTitle} lang="bash" code={`curl '${base}/api/v1/items?mode=selected&window=24h&limit=20'`} />
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[560px] text-left text-[13.5px]">
          <thead className="bg-bg-sunk text-ink-3"><tr><th className="px-3 py-2 font-medium">{c.api.colMethod}</th><th className="px-3 py-2 font-medium">{c.api.colPath}</th><th className="px-3 py-2 font-medium">{c.api.colDesc}</th></tr></thead>
          <tbody className="divide-y divide-line">
            {endpoints.map(([p, d]) => (
              <tr key={p}><td className="px-3 py-2 font-mono text-[12px] text-ok">GET</td><td className="px-3 py-2 font-mono text-[12.5px] text-ink">{p}</td><td className="px-3 py-2 text-ink-2">{c.api.endpoints[d]}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Section title={c.api.notesTitle}>
        <Bullets items={[
          c.api.note1,
          c.api.note2,
          c.api.note3,
          c.api.note4,
          c.api.note5,
        ]} />
      </Section>
      <Section title={c.api.snapshotTitle}>
        <CodeBlock lang="bash" code={c.api.snapshotCode(base)} />
        <p>{c.api.snapshotNote}</p>
      </Section>
      <Section title={c.api.errorsTitle} id="agent-api-recovery">
        <Bullets items={[
          c.api.error1,
          c.api.error2,
          c.api.error3,
          c.api.error4,
        ]} />
      </Section>
    </>
  );
}

export default function AgentPage() {
  const { tab: initialTab, healthy: healthyAtLoad, base } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const c = copy[locale];
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>(initialTab);
  // 这一页可以缓存 300 秒，状态球不能：缓存里的那一句"服务正常"最坏能说五分钟前的实话。
  // 首帧沿用页面加载时的判断（与服务端 HTML 一致，不多一次水合差异），到浏览器里再查一次。
  const [healthy, setHealthy] = useState(healthyAtLoad);

  // The loader validates `?tab=`; this effect is the same check for an address that changes in the
  // browser. It used to cast the raw value, so one unknown `?tab=` (a typo, a stale bookmark, a crawled
  // SEO variant) replaced the server's validated tab after hydration and blanked the panel — the content
  // region only renders for the three known keys, so what was left was an empty box under the heading.
  useEffect(() => {
    const next = params.get("tab");
    setTab(TABS.some((t) => t.key === next) ? (next as TabKey) : "mcp");
  }, [params]);

  useEffect(() => {
    const controller = new AbortController();
    // 与 loader 同一个 3 秒上界：读者面的健康探针不能把页面挂住。没有上界时，API 正在重启的那几秒
    // 里这一条 fetch 会一直 pending，浏览器（和 Playwright 的 networkidle）就永远等不到空闲。
    fetch(publicPath("/api/health"), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]), cache: "no-store" })
      .then((res) => setHealthy(res.ok))
      .catch(() => {
        // 查不动（被取消、离线、3 秒超时）：留在页面加载时的那个判断上，不编一个新的。
      });
    return () => controller.abort();
  }, []);

  const select = (key: TabKey) => {
    setTab(key);
    navigate(key === "mcp" ? "/agent" : `/agent?tab=${key}`, { replace: true, preventScrollReset: true });
  };

  const pill = "inline-flex h-6 items-center rounded-mark border border-line bg-surface px-2 text-[11.5px] text-ink-3";
  const aside = (
    <>
      <AsideCard title={c.resources.title} className="hidden lg:block">
        <nav aria-label={c.resources.title} className="-mx-2 -mb-1">
          {RESOURCES.map(([l, h, noteKey]) => (
            <a key={h} href={publicPath(h)} className="group flex items-start gap-2 rounded-control px-2 py-2 transition-colors hover:bg-bg-sunk">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink-2 group-hover:text-ink">{l}</span>
                <span className="mt-0.5 block text-[12px] text-ink-4">{c.resources[noteKey]}</span>
              </span>
              <IconArrowUpRight size={13} className="mt-1 shrink-0 text-ink-4" />
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title={c.troubleshoot.title}>
        <p className="text-[13px] leading-[1.75] text-ink-3">{c.troubleshoot.body}</p>
        <Link to={localeAppPath("/feedback", locale)} prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          {c.troubleshoot.go} <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );
  return (
    <ReadingLayout aside={aside}>
      <header>
        <p className="mb-3 text-[12px] font-semibold tracking-[0.16em] text-accent">{c.kicker}</p>
        <h1 className="text-[28px] font-bold leading-[1.35] text-ink sm:text-[34px]">{c.headline}</h1>
        <p className="measure mt-4 text-[15px] leading-[1.9] text-ink-3">{c.lead}</p>
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className={pill}>{c.pillAnonymous}</span>
          <span className={`${pill} mono`}>API v1</span>
          <span className={`${pill} mono`}>MCP {MCP_VERSION}</span>
          <span className={`${pill} gap-1.5 ${healthy ? "text-ok" : "text-hot"}`} title={c.statusTitle}>
            <span className={`size-1.5 rounded-full ${healthy ? "bg-ok" : "bg-hot"}`} />
            {healthy ? c.statusOk : c.statusDown}
          </span>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] lg:hidden">
        {RESOURCES.map(([l, h]) => (
          <a key={h} href={publicPath(h)} className="inline-flex items-center gap-1 text-ink-2 transition-colors hover:text-accent">
            {l} <IconArrowUpRight size={12} className="text-ink-4" />
          </a>
        ))}
      </div>

      <nav aria-label={c.tabsAria} className="my-8 grid gap-3 sm:grid-cols-3">
        {TABS.map(t => <button key={t.key} type="button" onClick={() => select(t.key)} aria-pressed={tab === t.key}
          className={`rounded-card border p-5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent ${tab === t.key ? "border-accent bg-accent/5" : "border-line bg-surface hover:border-accent/50"}`}>
          <span className="block text-[12px] text-ink-4">{c.tabs[t.key].hint}</span>
          <span className="mt-2 block text-[19px] font-bold text-ink">{t.label}</span>
          <span className="mt-2 block text-[13px] leading-[1.75] text-ink-3">{c.tabs[t.key].note}</span>
        </button>)}
      </nav>

      {/* Not role=tabpanel: the switch above is a radiogroup, and a tabpanel without a tab is a
          contract nothing satisfies. A named region carries the same "where am I" for a reader. */}
      <div className="border-t border-line pt-7" role="region" aria-label={c.regionAria}>
        {tab === "mcp" && <McpTab base={base} />}
        {tab === "rss" && <RssTab base={base} />}
        {tab === "api" && <ApiTab base={base} />}
      </div>
    </ReadingLayout>
  );
}
