/** VN local helpers for staff attendance (UTC+7, no DST). */
const OFFSET = 7 * 3600_000;
export const vnDate = (d: Date) => new Date(d.getTime() + OFFSET).toISOString().slice(0, 10);
export const vnHm = (d: Date) => new Date(d.getTime() + OFFSET).toISOString().slice(11, 16);
/** "2026-10-09" + "07:00" (VN) → Date */
export const vnAt = (date: string, hm: string) => new Date(`${date}T${hm}:00+07:00`);
export const minutesOf = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
export const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** inclusive list of dates */
export function datesBetween(from: string, to: string, max = 62): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) out.push(d);
  return out;
}
/** ISO weekday 1 = Monday … 7 = Sunday */
export const isoWeekday = (d: string) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
