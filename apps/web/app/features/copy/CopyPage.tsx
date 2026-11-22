import type { ReactNode } from "react";
import { Link } from "react-router";
import type { CopyDocument, RenderedCopy } from "../../lib/markdown";
import { ArticleLayout, RailSection } from "../../components/ui/Page";
import { localeAppPath, useLocale } from "../../lib/i18n";
import { copy } from "../../lib/i18n/pages/copy";

/**
 * Legal and policy pages, read like articles: the document on the page in one column, its facts in the
 * left rail and its outline in the right (phones get the facts above the text and no outline).
 * 侧栏的栏目名与事实键显示名随页面语言走（lib/i18n/pages/copy.ts）；meta 值来自文档本身。
 */
export function CopyPage({ doc, rendered, eyebrow, footer, aside }: { doc: CopyDocument; rendered: RenderedCopy; eyebrow?: ReactNode; footer?: ReactNode; aside?: ReactNode }) {
  const c = copy[useLocale()];
  const facts = (["版本", "生效日期", "运营主体", "备案号"] as const).filter((k) => doc.meta[k]);
  const info = facts.length > 0 && (
    <RailSection title={c.infoTitle}>
      <dl className="space-y-2 text-[12.5px]">
        {facts.map((k) => (
          <div key={k}>
            <dt className="text-ink-4">{c.fact[k]}</dt>
            <dd className="mt-0.5 text-ink-2">{doc.meta[k]}</dd>
          </div>
        ))}
      </dl>
    </RailSection>
  );
  const outline = rendered.outline.length > 2 && (
    <RailSection title={c.tocTitle}>
      <nav aria-label={c.tocAria}>
        <ol className="-ml-px space-y-0.5 border-l border-line">
          {rendered.outline.map((o) => (
            <li key={o.id}>
              <a href={`#${o.id}`} className="-ml-px block border-l border-transparent py-1 pl-3 text-[12.5px] leading-snug text-ink-3 transition-colors hover:border-accent hover:text-ink">
                {o.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </RailSection>
  );
  return (
    <ArticleLayout
      left={
        <>
          {aside}
          {info}
        </>
      }
      right={
        <>
          <div className="space-y-8 2xl:hidden">{info}</div>
          {outline}
        </>
      }
    >
      <article className="pb-14 pt-5 lg:pt-2">
        {eyebrow && <div className="mb-2.5 text-[12px] font-semibold text-accent">{eyebrow}</div>}
        <h1 className="text-[26px] font-bold leading-[1.35] text-ink lg:text-[32px] xl:text-[36px] xl:leading-[1.3]">{doc.title}</h1>
        {doc.intro && <p className="mt-4 text-[15px] leading-[1.8] text-ink-3 xl:text-[16px]">{doc.intro}</p>}
        {facts.length > 0 && (
          <dl className="mt-5 grid grid-cols-1 border-y border-line text-[12.5px] sm:grid-cols-2 lg:hidden">
            {facts.map((k) => (
              <div key={k} className="flex gap-4 border-b border-line-soft py-2.5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0">
                <dt className="w-16 shrink-0 text-ink-4">{c.fact[k]}</dt>
                <dd className="min-w-0 text-ink-2">{doc.meta[k]}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="prose prose-compact mt-6 lg:mt-8" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        {footer && <div className="mt-12 border-t border-line pt-5 text-[12.5px] text-ink-3">{footer}</div>}
      </article>
    </ArticleLayout>
  );
}

export function LegalFooterLinks({ links, note }: { links: Array<{ to: string; label: string; id?: string }>; note?: string }) {
  // 站内去处随页面语言折算：/en/terms 页脚的「隐私政策」若落 /privacy，读者就被换到中文页。
  const locale = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {links.map((l) => (
        <Link key={l.to} id={l.id} to={localeAppPath(l.to, locale)} className="text-accent hover:underline">{l.label}</Link>
      ))}
      {note && <span className="text-ink-4">{note}</span>}
    </div>
  );
}
