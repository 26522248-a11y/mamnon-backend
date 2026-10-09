const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function readTriple(n: number, full: boolean): string {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
  const out: string[] = [];
  if (full || h > 0) out.push(DIGITS[h], 'trăm');
  if (t > 1) {
    out.push(DIGITS[t], 'mươi');
    if (u === 1) out.push('mốt'); else if (u === 5) out.push('lăm'); else if (u === 4) out.push('tư'); else if (u > 0) out.push(DIGITS[u]);
  } else if (t === 1) {
    out.push('mười');
    if (u === 5) out.push('lăm'); else if (u > 0) out.push(DIGITS[u]);
  } else if (u > 0) {
    if (full || h > 0) out.push('lẻ');
    out.push(DIGITS[u]);
  }
  return out.join(' ');
}

/** 1500000 -> "Một triệu năm trăm nghìn đồng" */
export function vndInWords(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0) return '';
  if (amount === 0) return 'Không đồng';
  const units = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];
  const groups: number[] = [];
  for (let n = amount; n > 0; n = Math.floor(n / 1000)) groups.push(n % 1000);
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    parts.push(readTriple(groups[i], i < groups.length - 1), units[i]);
  }
  const s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() + ' đồng';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
