// History-entry caches keep same-document returns synchronous. Writes are coalesced after interaction;
// hiding/leaving the document flushes them so a browser back/forward reload can restore the same data.
interface Timed { savedAt: number }
const MAX_MEMORY_ENTRIES = 20;

export function sessionCache<T extends Timed>(prefix: string, maxAge: number) {
  const memory = new Map<string, T>();
  const dirty = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    for (const [key, value] of dirty) {
      const body = JSON.stringify(value);
      try {
        sessionStorage.setItem(prefix + key, body);
      } catch {
        // 配额满：一路滑到底之后，一份列表快照可以有 ~3 MB（2,381 张卡片实测 643 字符/张），
        // 而同一页上还有另一族缓存共用这 ~5 MB。以前这里是"吞掉异常"——于是"返回时恢复位置"
        // 这件事悄悄不成立了，谁也不知道。本族的每一条都只是"回来时少翻两页"的便利，
        // 所以先把自己这一族的旧条目全清掉再试一次；还写不进就认了（内存里那份仍然有效）。
        try {
          for (let i = sessionStorage.length - 1; i >= 0; i--) {
            const k = sessionStorage.key(i);
            if (k?.startsWith(prefix)) sessionStorage.removeItem(k);
          }
          sessionStorage.setItem(prefix + key, body);
        } catch { /* memory still works */ }
      }
    }
    dirty.clear();
  }
  function remember(key: string, value: T) {
    memory.delete(key);
    memory.set(key, value);
    if (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
  }
  function peek(key: string): T | null {
    const value = memory.get(key) ?? dirty.get(key);
    if (!value) return null;
    if (Date.now() - value.savedAt <= maxAge) return value;
    memory.delete(key);
    dirty.delete(key);
    try { sessionStorage.removeItem(prefix + key); } catch { /* unavailable */ }
    return null;
  }
  function read(key: string): T | null {
    const hit = peek(key);
    if (hit) return hit;
    try {
      const raw = sessionStorage.getItem(prefix + key);
      if (!raw) return null;
      const value = JSON.parse(raw) as T;
      if (!value || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > maxAge) {
        sessionStorage.removeItem(prefix + key);
        return null;
      }
      remember(key, value);
      return value;
    } catch { return null; }
  }
  function set(key: string, value: T) {
    remember(key, value);
    dirty.set(key, value);
    if (!listening) {
      listening = true;
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
      // Expired history entries should not occupy the session storage quota indefinitely.
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const storedKey = sessionStorage.key(i);
          if (!storedKey?.startsWith(prefix)) continue;
          try {
            const old = JSON.parse(sessionStorage.getItem(storedKey)!);
            if (!old || !Number.isFinite(old.savedAt) || Date.now() - old.savedAt > maxAge) sessionStorage.removeItem(storedKey);
          } catch { sessionStorage.removeItem(storedKey); }
        }
      } catch { /* unavailable */ }
    }
    timer ??= setTimeout(flush, 50);
    // pagehide handlers may save a newer anchor after our flush handler has already run.
    if (document.visibilityState === "hidden") flush();
  }
  return { peek, read, set, flush };
}
