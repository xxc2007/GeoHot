// A value read from the database and kept in this process. Readers get it straight away within
// `freshMs`; after that the old value is still returned while a single background read replaces it,
// so no reader waits for a refresh. Past `maxStaleMs` (or before the first read) callers wait for the
// read. Concurrent readers always share one read.

export interface Cached<T> {
  get(): Promise<T>;
  clear(): void;
}

export function cached<T>(load: () => Promise<T>, opts: { freshMs: number; maxStaleMs: number }): Cached<T> {
  let value: { at: number; data: T } | null = null;
  let pending: Promise<T> | null = null;
  let generation = 0;

  const refresh = (): Promise<T> => {
    if (pending) return pending;
    const mine = generation;
    pending = load()
      .then((data) => {
        if (mine === generation) value = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    get() {
      const age = value ? Date.now() - value.at : Infinity;
      if (value && age < opts.freshMs) return Promise.resolve(value.data);
      if (value && age < opts.maxStaleMs) {
        // A failed background read keeps the old value; the next reader tries again.
        refresh().catch(() => {});
        return Promise.resolve(value.data);
      }
      return refresh();
    },
    clear() {
      generation += 1;
      value = null;
      pending = null;
    },
  };
}
