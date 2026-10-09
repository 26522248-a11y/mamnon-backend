const TZ = () => process.env.TZ_SCHOOL || 'Asia/Ho_Chi_Minh';
/** Today as YYYY-MM-DD in the school's timezone. */
export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
/** Whole-day difference a - b for YYYY-MM-DD strings. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
export const isDateStr = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

/**
 * Overdue rule (PM): an invoice due on day D becomes overdue at 00:01 Vietnam time on D+1.
 * Returns the cutoff date C such that an unpaid invoice is overdue iff dueDate < C.
 */
export function overdueCutoff(now = new Date()): string {
  const vn = new Date(now.getTime() + 7 * 3600_000); // UTC+7, no DST
  const today = vn.toISOString().slice(0, 10);
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return minutes >= 1 ? today : addDays(today, -1);
}
