/** Read-only refresh: failure keeps the last good page; eligibility is checked again at commit. */
export async function refreshPublicData<T>(url: string | readonly string[], signal: AbortSignal, eligible: () => boolean, commit: (data: T) => void): Promise<boolean> {
  if (signal.aborted || !eligible()) return false;
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const read = async (endpoint: string) => {
      const response = await fetch(endpoint, { signal: deadline });
      if (!response.ok) throw new Error(`Public refresh ${response.status}`);
      return response.json();
    };
    const data = (typeof url === "string" ? await read(url) : await Promise.all(url.map(read))) as T;
    if (signal.aborted || !eligible()) return false;
    commit(data);
    return true;
  } catch { return false; }
}

export function atQuietPageHead(): boolean {
  return document.visibilityState === "visible" && window.scrollY <= 4
    && !document.querySelector('[role="dialog"], dialog[open]')
    && !(document.activeElement instanceof Element && document.activeElement.closest('input, textarea, select, [contenteditable="true"]'));
}
