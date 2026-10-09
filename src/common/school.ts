/** School identity from env (SCHOOL_NAME, SCHOOL_ADDRESS, SCHOOL_PHONE); used by /settings/school, receipts, vouchers, Excel exports. */
export const schoolInfo = () => ({
  name: process.env.SCHOOL_NAME?.trim() || 'Trường Mầm non',
  address: process.env.SCHOOL_ADDRESS?.trim() || null,
  phone: process.env.SCHOOL_PHONE?.trim() || null,
});
