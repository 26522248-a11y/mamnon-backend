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
  bankTransfer: (({ enabled, sample }) => ({ enabled, sample }))(bankConfig()),
});

export const isProduction = () => process.env.NODE_ENV === 'production';
const SAMPLE_BANK = { bin: '970436', accountNo: '0000000000', accountName: 'DU LIEU MAU - KHONG CHUYEN TIEN' };
/**
 * School bank account for VietQR (BANK_BIN, BANK_ACCOUNT_NO, BANK_ACCOUNT_NAME).
 * Not configured: non-production → sample account (sample: true); production → disabled (never a sample).
 */
export const bankConfig = () => {
  const bin = process.env.BANK_BIN?.trim(), accountNo = process.env.BANK_ACCOUNT_NO?.trim(), accountName = process.env.BANK_ACCOUNT_NAME?.trim();
  if (bin && accountNo && accountName) return { enabled: true, sample: false, bank: { bin, accountNo, accountName } };
  if (isProduction()) return { enabled: false, sample: false, bank: null };
  return { enabled: true, sample: true, bank: SAMPLE_BANK };
};
