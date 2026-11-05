import { useEffect, useState, type ReactNode } from "react";
import { IconMonitor, IconMoon, IconSun } from "../icons";
import { radioKeyNav } from "../ui/Tabs";
import { resolvedTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";

type Choice = "dark" | "system" | "light";

const OPTIONS: Array<{ key: Choice; label: string; icon: ReactNode }> = [
  { key: "dark", label: "深色", icon: <IconMoon size={14} /> },
  { key: "system", label: "跟随系统", icon: <IconMonitor size={14} /> },
  { key: "light", label: "浅色", icon: <IconSun size={14} /> },
];

/** Three-way appearance switch (dark / follow the system / light) with a sliding thumb. */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const pref = useThemePreference();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current: Choice = !mounted ? "system" : (pref ?? "system");
  // Never -1: a stored preference this build does not know must still leave the group one tab stop.
  const index = Math.max(0, OPTIONS.findIndex((o) => o.key === current));

  const choose = (key: Choice) => {
    const nextPref: ThemePreference = key === "system" ? null : key;
    const apply = () => {
      setThemePreference(nextPref);
      document.documentElement.setAttribute("data-theme", resolvedTheme(nextPref));
    };
    // 切换动画会被打断：标签页在这一瞬被隐藏、或者下一次点击又起了一次切换，浏览器会把
    // 这次 Transition 作废并让 `ready` 以 InvalidStateError 拒绝。若只挂回调，被作废那次
    // 的选择就丢了（点了深色却还是浅色）。所以在 `ready` 拒绝时补做一次 apply —— 幂等。
    const startTransition = (document as unknown as { startViewTransition?: (cb: () => void) => { ready: Promise<unknown> } }).startViewTransition;
    if (!startTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      apply();
      return;
    }
    const transition = startTransition(apply);
    transition.ready.catch(() => apply());
    // `finished` 同样会以 InvalidStateError 拒绝（被下一次切换顶掉时），不接就是一个未处理的拒绝。
    (transition as { finished?: Promise<unknown> }).finished?.catch(() => {});
  };

  return (
    <div role="radiogroup" aria-label="外观" className={`relative grid h-[34px] grid-cols-3 rounded-full border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] transition-transform duration-200 ease-[var(--ease-out-quart)]"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o, i) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          tabIndex={i === index ? 0 : -1}
          title={o.label}
          onKeyDown={(e) => radioKeyNav(e, (to) => choose(OPTIONS[to].key))}
          onClick={() => choose(o.key)}
          className={`relative z-10 flex items-center justify-center rounded-full transition-colors duration-150 ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
