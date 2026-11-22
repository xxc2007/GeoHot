import { SITE } from "@aihot/industry/site";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import copyZh from "@aihot/industry/pages/privacy.md?raw";
import { localeFromPath, useLocale, type Locale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/privacy";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";
import type { Route } from "./+types/privacy";

// 英文静态页（industry/pages/privacy.en.md）用 glob 懒匹配、不用直接 ?raw 导入：
// 文件缺失时键表为空，英文版整体回退中文，构建也不会因缺文件而失败。
const COPY_EN = Object.values(
  import.meta.glob<string>("../../../../industry/pages/privacy*.en.md", { eager: true, query: "?raw", import: "default" }),
)[0];

// 每个语言各准备一次静态文案（模块级准备，meta() 与组件共用）。
const PRIVACY: Record<Locale, ReturnType<typeof prepareCopy>> = {
  zh: prepareCopy(copyZh),
  en: prepareCopy(COPY_EN ?? copyZh),
};

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  const c = copy[locale];
  return pageMeta({ title: c.metaTitle, description: c.metaDescription, path: "/privacy", image: "/og/pages/privacy.png", locale });
}

export default function PrivacyPage() {
  const locale = useLocale();
  const c = copy[locale];
  const p = PRIVACY[locale];
  return (
    <CopyPage
      doc={p.doc}
      rendered={p.rendered}
      eyebrow={SITE.name}
      footer={<LegalFooterLinks links={[{ to: "/terms", label: c.footerTerms }, { to: "/feedback", label: c.footerFeedback }]} note={`${c.footerNote} ${p.doc.meta["版本"] ?? ""} · ${p.doc.meta["生效日期"] ?? ""}`} />}
    />
  );
}
