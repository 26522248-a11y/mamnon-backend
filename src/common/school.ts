/** School identity from env (SCHOOL_NAME, SCHOOL_ADDRESS, SCHOOL_PHONE); used by /settings/school, receipts, vouchers, Excel exports. */
export const schoolInfo = () => ({
  name: process.env.SCHOOL_NAME?.trim() || 'Trường Mầm non',
  address: process.env.SCHOOL_ADDRESS?.trim() || null,
  phone: process.env.SCHOOL_PHONE?.trim() || null,
});

const hm = (v: string | undefined, d: string) => (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : d);
/** Parent absence report / cancel for TODAY must be strictly before this VN time (refund + free cancel). */
export const absenceCutoff = () => hm(process.env.ABSENCE_CUTOFF, '08:00');
export const latestPickupTime = () => hm(process.env.LATEST_PICKUP_TIME, '18:00');
export const schoolOpenTime = () => hm(process.env.SCHOOL_OPEN_TIME, '06:30');
export const medicineLateMinutes = () => {
  const n = Number(process.env.MEDICINE_LATE_MINUTES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
};
/** Roles notified about meal-count changes ("kitchen"). */
export const kitchenNotifyRoles = () => (process.env.KITCHEN_NOTIFY_ROLES ?? 'admin,accountant').split(',').map((s) => s.trim()).filter(Boolean);
/** Current VN wall-clock time HH:MM (UTC+7, no DST). */
export const vnNowHM = (now = new Date()) => new Date(now.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
export const beforeAbsenceCutoff = (now = new Date()) => vnNowHM(now) < absenceCutoff();
/** Public school settings (GET /settings/school). */
export const schoolSettings = () => ({
  ...schoolInfo(),
  absenceCutoff: absenceCutoff(), latestPickupTime: latestPickupTime(), latestPickup: latestPickupTime(),
  schoolOpenTime: schoolOpenTime(), medicineLateMinutes: medicineLateMinutes(),
});
