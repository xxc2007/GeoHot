import { forwardRef, useId, type ButtonHTMLAttributes, type SelectHTMLAttributes } from "react";
import { IconChevronDown } from "../icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-ink disabled:opacity-45",
  secondary: "border border-line-strong bg-surface text-ink-2 hover:border-ink-4 hover:text-ink disabled:opacity-50",
  ghost: "text-ink-3 hover:bg-bg-sunk hover:text-ink disabled:opacity-50",
  danger: "bg-hot text-white hover:opacity-90 disabled:opacity-45",
};

type Size = "sm" | "md" | "lg";
const SIZES: Record<Size, string> = { sm: "h-8 px-3 text-[12.5px]", md: "h-9 px-4 text-[13.5px]", lg: "h-11 px-5 text-[14.5px]" };

/** The pill button's classes, for links that look like buttons. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md"): string {
  return `inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] ${SIZES[size]} ${VARIANTS[variant]}`;
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(function Button(
  { variant = "secondary", size = "md", className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`${buttonClass(variant, size)} ${className}`}
      {...rest}
    />
  );
});

/** Native select as a pill, like the site's other controls. */
export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  // Every select gets an `id`, even when the caller did not pass one: Chrome flags a form field without
  // an id or name ("should have an id or name attribute") and fires an autofill/scrape heuristic at it.
  const autoId = useId();
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        id={rest.id ?? autoId}
        className="h-8 w-full cursor-pointer appearance-none rounded-full border border-line-strong bg-surface py-0 pl-3.5 pr-8 text-[12.5px] text-ink-2 outline-none transition-[border-color,box-shadow] hover:border-ink-4 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        {...rest}
      >
        {children}
      </select>
      <IconChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-4" />
    </span>
  );
}
