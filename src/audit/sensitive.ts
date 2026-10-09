/** B18: sensitive-change history = a typed, masked, read-only view over audit_events. */

export const SENSITIVE_TYPES = ['guardian_unlink', 'phone_change', 'photo_consent'] as const;
export type SensitiveType = (typeof SENSITIVE_TYPES)[number];

/** audit_events.action values behind each type */
export const TYPE_ACTIONS: Record<SensitiveType, string[]> = {
  guardian_unlink: ['guardian.remove'],
  phone_change: ['child.contact_phones', 'user.phone'],
  photo_consent: ['child.photo_consent'],
};
export const TYPE_LABELS: Record<SensitiveType, string> = { guardian_unlink: 'Gỡ liên kết', phone_change: 'SĐT', photo_consent: 'Đồng ý ảnh' };
export const actionType = (action: string): SensitiveType | null =>
  (Object.keys(TYPE_ACTIONS) as SensitiveType[]).find((t) => TYPE_ACTIONS[t].includes(action)) ?? null;

/** "0912345456" → "0912 *** 456"; short / odd values → "***". Keeps a leading "+". */
export function maskPhone(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[\s.-]/g, '');
  const plus = s.startsWith('+') ? '+' : '';
  const d = s.replace(/\D/g, '');
  if (d.length < 7) return '***';
  return `${plus}${d.slice(0, 4)} *** ${d.slice(-3)}`;
}

/** Deep copy with every key containing "phone" masked. */
export function maskPhones<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => maskPhones(x)) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = /phone/i.test(k) && (typeof x === 'string' || typeof x === 'number') ? maskPhone(x) : maskPhones(x);
    }
    return o as T;
  }
  return v;
}

const consentText = (c: unknown) => (c === true ? 'Đồng ý' : c === false ? 'Không đồng ý' : 'Chưa chọn');
const phonesText = (o: any) => {
  if (!o) return '—';
  if ('phone' in o) return o.phone ?? '—';
  const p = [o.phone1, o.phone2].filter(Boolean);
  return p.length ? p.join(' / ') : '—';
};

/** Human summary of before / after (input must already be masked). */
export function describe(action: string, before: any, after: any): { beforeText: string; afterText: string } {
  switch (action) {
    case 'guardian.remove': {
      const b = before ?? {};
      const who = [b.fullName, b.relation ? `(${b.relation})` : null].filter(Boolean).join(' ');
      return { beforeText: [who || 'Người giám hộ', b.phone].filter(Boolean).join(' · '), afterText: 'Đã gỡ' };
    }
    case 'child.photo_consent': return { beforeText: consentText(before?.consent), afterText: consentText(after?.consent) };
    case 'child.contact_phones':
    case 'user.phone': return { beforeText: phonesText(before), afterText: phonesText(after) };
    default: return { beforeText: before ? JSON.stringify(before) : '—', afterText: after ? JSON.stringify(after) : '—' };
  }
}

/** CSV cell: quoted, and neutralises spreadsheet formulas (=, +, -, @, tab, CR at the start). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export type PhoneSlot = { slot: string; value: string | null; changed: boolean };
const PHONE_SLOTS = ['phone1', 'phone2', 'phone'];
const digits = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\D/g, ''));

/**
 * Phone-change rows: one entry per number in `after`, masked, with `changed` = this number was not among the numbers in
 * `before` (compared on RAW digits server-side, so swapped order is not a change). Raw numbers never leave the server.
 */
export function phoneSlots(action: string, rawBefore: any, rawAfter: any): PhoneSlot[] | null {
  if (action !== 'child.contact_phones' && action !== 'user.phone') return null;
  const old = new Set(PHONE_SLOTS.map((k) => digits(rawBefore?.[k])).filter(Boolean));
  return PHONE_SLOTS.filter((k) => rawAfter && k in rawAfter)
    .map((k) => ({ slot: k, value: maskPhone(rawAfter[k]), changed: !!digits(rawAfter[k]) && !old.has(digits(rawAfter[k])) }));
}
