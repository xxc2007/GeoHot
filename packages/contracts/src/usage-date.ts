/** Dashboard dates are civil days in Beijing, never the browser's local timezone. */
export function beijingToday(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
export function usageDate(value?: string, today = beijingToday()): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value && value <= today && value >= '2000-01-01' ? value : null;
}
export function usageMonth(value?: string, today = beijingToday()): string {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '2000-01' && value <= today.slice(0, 7) ? value : today.slice(0, 7);
}
