export interface RoutingSample { service: string; model: string; purpose: string; total: number; accepted: number; median_ms: number | null; pending: number }

/** Keep every healthy member eligible. Learn only from enough real, non-trivial calls. */
export function routingWeights(members: Array<{ name: string; service: string; model: string }>, purpose: string, samples: RoutingSample[]): Map<string, number> {
  const stats = new Map(samples.filter(s => s.purpose === purpose).map(s => [`${s.service}|${s.model}`, s]));
  const distinct = [...new Map(members.map(m => [`${m.service}|${m.model}`,m])).values()];
  const measured = distinct.map(m => stats.get(`${m.service}|${m.model}`)).filter((s): s is RoutingSample => !!s && s.accepted >= 6 && s.median_ms !== null && s.median_ms >= 1000 && s.accepted / s.total >= .8);
  if (measured.length < 2) return new Map(members.map(m => [m.name, 1]));
  const fastest = Math.min(...measured.map(s => s.median_ms!));
  return new Map(members.map(m => {
    const s = stats.get(`${m.service}|${m.model}`);
    if (!s || s.accepted < 6 || !s.median_ms || s.median_ms < 1000 || s.accepted / s.total < .8) return [m.name, 1];
    const quality = (s.accepted / s.total) ** 2;
    return [m.name, Math.max(1, Math.min(4, Math.round(4 * fastest / Math.max(1000, s.median_ms) * quality / (1 + s.pending))))];
  }));
}
