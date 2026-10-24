/** Short-lived, in-process snapshots for authenticated operational counters, never sessions or writes. */
export function sharedAdminRead<T>(ttlMs: number, load: () => Promise<T>, fallback?: {
  staleIfErrorMs: number;
  canUseStale: (error: unknown) => boolean;
  markStale: (value: T) => T;
}): () => Promise<T> {
  let saved: { until: number; value: T } | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    if (saved && saved.until > Date.now()) return Promise.resolve(saved.value);
    if (pending) return pending;
    pending = load().then(value => {
      saved = { until: Date.now() + ttlMs, value };
      return value;
    }).catch(error => {
      // Never renew the saved timestamp on failure or hide errors indefinitely.
      if (saved && fallback && Date.now() < saved.until + fallback.staleIfErrorMs && fallback.canUseStale(error)) {
        return fallback.markStale(saved.value);
      }
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
