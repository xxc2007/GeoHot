import { beijingWeekday } from "../../lib/format";

/** Release notes carry a little Markdown: **bold** runs. */
export function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) => {
        if (i % 2) return <b key={i} className="font-semibold text-ink-2">{part}</b>;
        // 含邮箱的段落要让 React 忍一下文本差异：Cloudflare 的邮箱保护会在边缘把
        // `xxc200707@qq.com` 换成 `[email protected]` 并包一层 <a href="/cdn-cgi/l/…">，
        // 服务端 HTML 与客户端从 JSON 渲染的文本于是不同 —— 2026-11-05 实测 /changelog
        // 抛 Minified React error #418（hydration 文本不一致），页面上报警、控制台一片红。
        // 边缘脚本在 hydrate 之后仍会把真实邮箱写回可见文本，所以这里只压掉这次误判。
        if (part.includes("@")) return <span key={i} suppressHydrationWarning>{part}</span>;
        return part;
      })}
    </>
  );
}

export function dateHeading(date: string): { label: string; weekday: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { label: `${y} 年 ${m} 月 ${d} 日`, weekday: beijingWeekday(date).replace("星期", "周") };
}
