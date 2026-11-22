import { Link } from "react-router";
import type { Route } from "./+types/search-busy";
import { titled } from "../lib/seo";
import { localeAppPath, localeFromPath, useLocale } from "../lib/i18n";
import { copy } from "../lib/i18n/pages/search-busy";
import { RingMark } from "../components/Logo";

// 组件原先住在 routes/all.tsx 的 `SearchBusy` 导出（只有本路由引用它）；英文化时按 hot.tsx 的
// 样板落回自己的路由文件，all.tsx 不再改动。页面没有 API 动态内容，全是界面文案，无需 ChineseNotice。
export function meta({ location }: Route.MetaArgs) {
  const locale = localeFromPath(location.pathname);
  return [{ title: titled(copy[locale].metaTitle) }, { name: "robots", content: "noindex, follow" }];
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function SearchBusyPage() {
  const locale = useLocale();
  const c = copy[locale];
  return (
    <div className="mx-auto max-w-sm py-24 text-center">
      <RingMark className="mx-auto mb-5 size-10 text-accent" spinning />
      <h1 className="text-[20px] font-bold text-ink">{c.title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-3">{c.body}</p>
      <div className="mt-6 flex justify-center gap-2.5">
        <Link to={localeAppPath("/all", locale)} className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-contrast hover:bg-accent-ink">{c.browseAll}</Link>
        <Link to={localeAppPath("/", locale)} reloadDocument className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13.5px] text-ink-2 hover:border-ink-4">{c.backSelected}</Link>
      </div>
    </div>
  );
}
