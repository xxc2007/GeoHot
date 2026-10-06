// A lazily loaded overlay (海报、目录抽屉) throws during render when its chunk cannot be downloaded —
// offline, or a page that outlived the build it was served from. Without a boundary here that throw
// reaches `root.tsx`'s ErrorBoundary and replaces the whole article the reader was reading.
import { Component, type ReactNode } from "react";

export class ChunkBoundary extends Component<{ children: ReactNode; label: string; onDismiss: () => void }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    // 「重试」不重新渲染 children：`lazy()` 记住的是那个已经失败的 import，再渲染一次只是再抛一次。
    // 刷新页面才是这条路的出口，而关闭至少把文章还给读者。
    return (
      <div role="alert" className="fixed inset-x-0 bottom-24 z-50 mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-card border border-line bg-raised px-4 py-3 text-[13px] text-ink-2 shadow-[var(--shadow-pop)]">
        <span>{this.props.label}没能加载，请刷新页面重试。</span>
        <button type="button" className="shrink-0 text-accent hover:underline" onClick={this.props.onDismiss}>
          关闭
        </button>
      </div>
    );
  }
}
