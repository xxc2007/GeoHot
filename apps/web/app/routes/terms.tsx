import { SITE } from "@aihot/industry/site";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import copyZh from "@aihot/industry/pages/terms.md?raw";
import type { Locale } from "../lib/i18n";
import { localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/terms";
import type { Route } from "./+types/terms";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";

// 英文静态页（industry/pages/terms.en.md）与 privacy 同一套写法：glob 懒匹配、文件缺失时键表为空，
// 英文版整体回退中文、构建不因缺文件失败（直接 `?raw` 导入在缺文件时会让 CI 构建挂掉）。
const COPY_EN = Object.values(
  import.meta.glob<string>("../../../../industry/pages/terms*.en.md", { eager: true, query: "?raw", import: "default" }),
)[0];

const TERMS_ZH = prepareCopy(copyZh);
// 静态文案按 locale 选：英文文件缺失或被清空时回退中文文档。
const TERMS: Record<Locale, typeof TERMS_ZH> = {
  zh: TERMS_ZH,
  en: COPY_EN?.trim() ? prepareCopy(COPY_EN) : TERMS_ZH,
};

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({
    title: c.metaTitle,
    description: c.metaDescription,
    path: "/terms",
    image: "/og/pages/terms.png",
    locale,
  });
}

export default function TermsPage() {
  const locale = useLocale();
  const c = copy[locale];
  const terms = TERMS[locale];
  return (
    <CopyPage
      doc={terms.doc}
      rendered={terms.rendered}
      eyebrow={SITE.name}
      footer={<LegalFooterLinks links={[{ to: "/privacy", label: c.footerPrivacy }, { to: "/agent", label: c.footerAgent }]} note={c.footerNote(terms.doc.meta["版本"] ?? "", terms.doc.meta["生效日期"] ?? "")} />}
    />
  );
}
