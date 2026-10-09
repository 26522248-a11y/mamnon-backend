/** VietQR (NAPAS 247, EMVCo merchant-presented QR) payload builder. */
const tlv = (id: string, value: string) => `${id}${String(Buffer.byteLength(value, 'utf8')).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as 4 upper-case hex digits. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (const b of Buffer.from(s, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Transfer content is kept to what all banks accept: A–Z, 0–9, space, '-' (max 25 chars). */
export const safeContent = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'D').replace(/[^A-Za-z0-9 -]/g, '').slice(0, 25);

export function vietQrPayload(o: { bin: string; accountNo: string; amount: number; content: string }): string {
  const merchant = tlv('00', 'A000000727') + tlv('01', tlv('00', o.bin) + tlv('01', o.accountNo)) + tlv('02', 'QRIBFTTA');
  const body = tlv('00', '01') + tlv('01', '12') + tlv('38', merchant) + tlv('53', '704') + tlv('54', String(Math.round(o.amount)))
    + tlv('58', 'VN') + tlv('62', tlv('08', safeContent(o.content))) + '6304';
  return body + crc16(body);
}

/** Matches bank-statement content to an invoice code ignoring case and non-alphanumerics (banks may strip '-'). */
export const contentMatches = (content: string, invoiceNo: string) =>
  content.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(invoiceNo.toUpperCase().replace(/[^A-Z0-9]/g, ''));
