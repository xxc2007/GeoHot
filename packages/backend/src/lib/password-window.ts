/** Sliding password-attempt window, including rejected attempts, with constant storage. */
export function passwordWindow() {
  const events: Array<{ at: number; ip: string }> = [];
  return {
    reject(ip: string, now = Date.now()): boolean {
      while (events.length && now - events[0]!.at >= 15 * 60_000) events.shift();
      events.push({ at: now, ip });
      if (events.length > 51) events.shift();
      // With 51 live events the global limit already rejects. Otherwise this is the entire
      // live window, so the per-address count is exact too. Rejections extend the window.
      return events.length > 50 || events.filter((event) => event.ip === ip).length > 10;
    },
    get retained(): number { return events.length; },
  };
}
