/**
 * Excel import of children + guardians: template, parsing, validation (pure helpers; DB work lives in the controller).
 * Header matching ignores accents/case/"*"/"(…)", so "Họ tên bé *" == "ho ten be".
 */
import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as path from 'path';

export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type Field = 'fullName' | 'dob' | 'gender' | 'className' | 'allergies' | 'healthNotes' | 'address' | 'enrolledAt'
  | 'g1Name' | 'g1Relation' | 'g1Phone' | 'g1CanPickup' | 'g2Name' | 'g2Relation' | 'g2Phone' | 'g2CanPickup';

/** Template columns, in order. `required` = must be filled on every row. */
export const COLUMNS: { field: Field; header: string; required?: boolean; width: number; note: string; list?: string[]; text?: boolean }[] = [
  { field: 'fullName', header: 'Họ tên bé *', required: true, width: 26, note: 'Họ và tên đầy đủ của bé' },
  { field: 'dob', header: 'Ngày sinh *', required: true, width: 14, note: 'dd/mm/yyyy (vd 05/03/2022) hoặc ô kiểu ngày' },
  { field: 'gender', header: 'Giới tính *', required: true, width: 11, note: 'Nam / Nữ', list: ['Nam', 'Nữ'] },
  { field: 'className', header: 'Lớp *', required: true, width: 12, note: 'Tên lớp đúng như trong hệ thống (vd Mầm 1)' },
  { field: 'allergies', header: 'Dị ứng', width: 22, note: 'Để trống nếu không có' },
  { field: 'healthNotes', header: 'Ghi chú sức khỏe', width: 26, note: 'Bệnh nền, thuốc… (tuỳ chọn)' },
  { field: 'address', header: 'Địa chỉ', width: 28, note: 'Tuỳ chọn' },
  { field: 'enrolledAt', header: 'Ngày nhập học', width: 14, note: 'dd/mm/yyyy, tuỳ chọn (mặc định hôm nay)' },
  { field: 'g1Name', header: 'PH1 - Họ tên *', required: true, width: 22, note: 'Phụ huynh 1 (bắt buộc)' },
  { field: 'g1Relation', header: 'PH1 - Quan hệ', width: 12, note: 'Bố / Mẹ / Ông / Bà / … (mặc định Phụ huynh)', list: ['Bố', 'Mẹ', 'Ông', 'Bà', 'Anh', 'Chị', 'Cô', 'Dì', 'Chú', 'Bác', 'Người giám hộ'] },
  { field: 'g1Phone', header: 'PH1 - SĐT *', required: true, width: 14, note: '10 số, vd 0912345678. Dùng làm tên đăng nhập', text: true },
  { field: 'g1CanPickup', header: 'PH1 - Được đón', width: 12, note: 'Có / Không (mặc định Có)', list: ['Có', 'Không'] },
  { field: 'g2Name', header: 'PH2 - Họ tên', width: 22, note: 'Phụ huynh 2 (tuỳ chọn; nếu điền thì cần SĐT)' },
  { field: 'g2Relation', header: 'PH2 - Quan hệ', width: 12, note: 'như PH1', list: ['Bố', 'Mẹ', 'Ông', 'Bà', 'Anh', 'Chị', 'Cô', 'Dì', 'Chú', 'Bác', 'Người giám hộ'] },
  { field: 'g2Phone', header: 'PH2 - SĐT', width: 14, note: 'như PH1', text: true },
  { field: 'g2CanPickup', header: 'PH2 - Được đón', width: 12, note: 'Có / Không (mặc định Có)', list: ['Có', 'Không'] },
];

export const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
  .toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[*:_\-–/]+/g, ' ').replace(/\s+/g, ' ').trim();
const headerKey = (s: string) => norm(s).replace(/^phu huynh ?(\d)/, 'ph$1').replace(/\bso dien thoai\b|\bdien thoai\b/, 'sdt');
const HEADER_MAP = new Map<string, Field>(COLUMNS.map((c) => [headerKey(c.header), c.field]));
/** Person-name key for "same person?" checks: case- and whitespace-insensitive, diacritics KEPT ("nguyễn  thị hà" == "Nguyễn Thị Hà", but "Hà" != "Ha"). */
export const personKey = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
/** Normalised person / class name for matching ("  nguyễn  Gia An" == "Nguyễn Gia An"). */
export const nameKey = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');

export async function buildTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mầm non'; wb.created = new Date();
  const ws = wb.addWorksheet('Học sinh', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.field, width: c.width, style: c.text ? { numFmt: '@' } : {} }));
  const head = ws.getRow(1);
  head.font = { bold: true }; head.height = 30; head.alignment = { vertical: 'middle', wrapText: true };
  COLUMNS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    const color = c.field.startsWith('g1') ? 'FFDDEBF7' : c.field.startsWith('g2') ? 'FFE2EFDA' : 'FFFFF2CC';
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    cell.note = c.note;
    if (c.list) for (let r = 2; r <= MAX_IMPORT_ROWS + 1; r++)
      ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.list.join(',')}"`] };
  });
  for (let r = 2; r <= MAX_IMPORT_ROWS + 1; r++) for (const i of [2, 8]) ws.getCell(r, i).numFmt = 'dd/mm/yyyy';
  const guide = wb.addWorksheet('Hướng dẫn');
  guide.columns = [{ width: 22 }, { width: 90 }];
  const lines: [string, string][] = [
    ['MẪU NHẬP HỌC SINH', ''],
    ['Cách dùng', 'Điền mỗi bé một dòng ở sheet "Học sinh" (từ dòng 2). Không đổi tên / thứ tự cột tiêu đề. Tối đa 1000 dòng / file.'],
    ['Cột có dấu *', 'Bắt buộc. PH1 bắt buộc; PH2 tuỳ chọn (nếu điền họ tên thì phải có SĐT).'],
    ['Ngày', 'dd/mm/yyyy, vd 05/03/2022 (hoặc định dạng ô là Ngày).'],
    ['SĐT', '10 số bắt đầu bằng 0 (chấp nhận +84…). SĐT là tên đăng nhập của phụ huynh. Một phụ huynh nhiều con: ghi cùng SĐT ở các dòng.'],
    ['Tài khoản', 'SĐT chưa có tài khoản → tạo tài khoản phụ huynh, mật khẩu tạm có trong file kết quả (chỉ tải được một lần), bắt đổi khi đăng nhập lần đầu. SĐT đã có tài khoản phụ huynh → gắn bé vào tài khoản đó.'],
    ['SĐT đã có tài khoản', 'SĐT đã là tài khoản phụ huynh nhưng khác tên (không phân biệt hoa thường / khoảng trắng; CÓ phân biệt dấu) → LỖI, không gắn. Cùng một SĐT ghi tên khác nhau ở các dòng → LỖI. Nếu nhà trường đã xác minh đúng là cùng một người: xác nhận gắn trên màn hình nhập (từng dòng, từng phụ huynh).'],
    ['Trùng', 'Bé đã có trong hệ thống (cùng họ tên + ngày sinh) → bỏ qua dòng đó, không tạo trùng.'],
    ['Lớp', 'Tên lớp phải có sẵn trong hệ thống, trừ khi chọn "tự tạo lớp" khi nhập.'],
    ['Kiểm tra trước', 'Bấm "Kiểm tra" (dry run) để xem lỗi từng dòng; chỉ khi không còn lỗi mới nhập được. Nhập là tất cả hoặc không gì cả.'],
    ['Ví dụ', 'Nguyễn Gia Bảo | 05/03/2022 | Nam | Mầm 1 | Đậu phộng | | 12 Lê Lợi | | Nguyễn Văn Hùng | Bố | 0912345678 | Có | Trần Thị Mai | Mẹ | 0987654321 | Có'],
  ];
  lines.forEach(([a, b], i) => { const r = guide.addRow([a, b]); r.getCell(1).font = { bold: true }; r.getCell(2).alignment = { wrapText: true }; if (i === 0) r.font = { bold: true, size: 14 }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Raw cell -> trimmed string ('' when empty). Handles rich text, formulas, hyperlinks, numbers. */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text).join('').trim();
    if ('result' in o) return cellText(o.result);
    if ('text' in o) return String(o.text).trim();
    if ('error' in o) return '';
    return '';
  }
  return String(v).trim();
}

const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
/** Date cell / Excel serial / dd/mm/yyyy / yyyy-mm-dd -> YYYY-MM-DD or null. */
export function parseDate(v: ExcelJS.CellValue): string | null {
  if (v instanceof Date) return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'number' && v > 1 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  if (v && typeof v === 'object' && 'result' in (v as any)) return parseDate((v as any).result);
  const s = cellText(v);
  let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}
/** VN phone -> 0xxxxxxxxx or null. Numeric cells that lost the leading 0 are repaired. */
export function parsePhone(v: ExcelJS.CellValue): string | null {
  let s = typeof v === 'number' ? String(Math.trunc(v)) : cellText(v);
  s = s.replace(/[\s.\-()]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (/^84\d{9}$/.test(s)) s = '0' + s.slice(2);
  else if (/^[1-9]\d{8}$/.test(s)) s = '0' + s;
  return /^0[1-9]\d{8}$/.test(s) ? s : null;
}
const yesNo = (s: string): boolean | null => { const k = norm(s); return !k ? true : ['co', 'x', 'yes', 'y', '1', 'true', 'duoc'].includes(k) ? true : ['khong', 'no', 'n', '0', 'false', 'k'].includes(k) ? false : null; };
const gender = (s: string): 'M' | 'F' | null => { const k = norm(s); return ['nam', 'm', 'trai', 'be trai'].includes(k) ? 'M' : ['nu', 'f', 'gai', 'be gai'].includes(k) ? 'F' : null; };

export interface RowError { row: number; column: string | null; field: Field | null; value?: string; message: string; code?: string;
  existingAccount?: { userId: string; name: string; childrenCount: number } | null; conflictRow?: number }
export interface GuardianIn { slot: 1 | 2; fullName: string; relation: string; phone: string; canPickup: boolean }
/**
 * One non-blank data row. Every row is returned (also rows with field errors) so the DB-aware checks
 * (class exists, duplicate in file, staff phone) still run and the school sees ALL errors of a row at once.
 * Fields that failed validation are '' / null; guardians are listed when their phone is valid.
 */
export interface ParsedRow {
  row: number; fullName: string; dob: string | null; gender: 'M' | 'F' | null; className: string; allergies: string | null; healthNotes: string | null;
  address: string | null; enrolledAt: string | null; guardians: GuardianIn[];
}

const EXTRA_SHEET_PARTS = /\/(comments|vmlDrawing|drawing|table|printerSettings|threadedComment|person|ctrlProp|image|oleObject|package|pivotTable|queryTable|customProperty|webExtension)$/i;

/**
 * Rewrites an .xlsx package into the shape exceljs expects. Files saved by other tools (openpyxl, some Google Sheets /
 * LibreOffice / Excel versions) use absolute relationship targets ("/xl/worksheets/sheet1.xml", "/xl/comments/comment1.xml"),
 * which exceljs cannot resolve ("Cannot read properties of undefined (reading 'comments')").
 * `strip` additionally drops everything an import never needs (comments, drawings, tables, …) from the worksheets.
 */
export async function normalizeXlsx(buf: Buffer, strip: boolean): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const relsFiles = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /(^|\/)_rels\/[^/]*\.rels$/i.test(n));
  for (const name of relsFiles) {
    const baseDir = path.posix.dirname(path.posix.dirname(name)); // "xl/_rels/workbook.xml.rels" -> "xl", "_rels/.rels" -> "."
    const isSheetRels = /^xl\/(worksheets|chartsheets)\/_rels\//i.test(name);
    let xml = await zip.file(name)!.async('string');
    xml = xml.replace(/<Relationship\b[^>]*?\/>|<Relationship\b[^>]*>[\s\S]*?<\/Relationship>/g, (rel) => {
      if (/TargetMode\s*=\s*["']External["']/i.test(rel)) return rel;
      if (strip && isSheetRels) { const t = rel.match(/Type\s*=\s*["']([^"']*)["']/); if (t && EXTRA_SHEET_PARTS.test(t[1])) return ''; }
      return rel.replace(/Target\s*=\s*(["'])\/([^"']*)\1/, (_m, q, abs) => {
        const rel2 = baseDir === '.' ? abs : path.posix.relative(baseDir, abs);
        return `Target=${q}${rel2}${q}`;
      });
    });
    zip.file(name, xml);
  }
  if (strip) for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))) {
    const xml = await zip.file(name)!.async('string');
    zip.file(name, xml.replace(/<(\w+:)?(legacyDrawing|legacyDrawingHF|drawing|tableParts|controls|oleObjects|picture)\b[^>]*?(\/>|>[\s\S]*?<\/\1?\2>)/g, ''));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** exceljs first (fast path, files from Excel / the template); on failure retry with normalised, then stripped packages. */
export async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const attempts: (() => Promise<Buffer>)[] = [async () => buf, () => normalizeXlsx(buf, false), () => normalizeXlsx(buf, true)];
  let lastErr: unknown = new Error('no worksheet');
  for (const make of attempts) {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await make()) as any);
      if (wb.worksheets.length) return wb;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Checks the upload really is an .xlsx (zip magic + parses), finds the sheet and returns rows + per-row validation errors. */
export async function parseWorkbook(buf: Buffer, today: string): Promise<{ rows: ParsedRow[]; errors: RowError[]; totalRows: number; sheet: string }> {
  const { AppError } = await import('../common/errors');
  if (!buf?.length) throw new AppError(400, 'INVALID_FILE', 'Thiếu file .xlsx (trường "file")');
  if (buf.length > MAX_IMPORT_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'File quá 5MB');
  if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) throw new AppError(400, 'INVALID_FILE', 'File không phải Excel .xlsx (hãy dùng file mẫu, lưu dạng .xlsx)');
  let wb: ExcelJS.Workbook;
  try { wb = await loadWorkbook(buf); } catch { throw new AppError(400, 'INVALID_FILE', 'Không đọc được file Excel (.xlsx bị hỏng hoặc sai định dạng)'); }
  // first sheet whose first row contains the required headers
  let ws: ExcelJS.Worksheet | undefined; let colOf = new Map<Field, number>(); let missing: string[] = COLUMNS.filter((c) => c.required).map((c) => c.header);
  for (const s of wb.worksheets) {
    const map = new Map<Field, number>();
    s.getRow(1).eachCell((cell, col) => { const f = HEADER_MAP.get(headerKey(cellText(cell.value))); if (f && !map.has(f)) map.set(f, col); });
    const miss = COLUMNS.filter((c) => c.required && !map.has(c.field)).map((c) => c.header);
    if (!ws || miss.length < missing.length) { ws = s; colOf = map; missing = miss; }
    if (!miss.length) break;
  }
  if (!ws || missing.length) throw new AppError(400, 'TEMPLATE_MISMATCH', 'File không đúng mẫu: thiếu cột bắt buộc', { missingColumns: missing });
  const headerOf = (f: Field) => COLUMNS.find((c) => c.field === f)!.header;
  const raw: { row: number; get: (f: Field) => ExcelJS.CellValue }[] = [];
  const last = ws.actualRowCount ? ws.rowCount : 1;
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    const get = (f: Field) => (colOf.has(f) ? row.getCell(colOf.get(f)!).value : null);
    if (COLUMNS.every((c) => !cellText(get(c.field)))) continue; // blank line
    raw.push({ row: r, get });
    if (raw.length > MAX_IMPORT_ROWS) throw new AppError(400, 'TOO_MANY_ROWS', `Tối đa ${MAX_IMPORT_ROWS} dòng mỗi file; hãy chia nhỏ file`);
  }
  if (!raw.length) throw new AppError(400, 'EMPTY_FILE', 'File không có dòng dữ liệu nào (từ dòng 2)');

  const errors: RowError[] = [];
  const rows: ParsedRow[] = [];
  const minDob = `${Number(today.slice(0, 4)) - 8}${today.slice(4)}`;
  for (const { row, get } of raw) {
    const err = (field: Field, message: string, value?: ExcelJS.CellValue) => errors.push({ row, column: headerOf(field), field, value: value == null ? undefined : cellText(value), message });
    const txt = (f: Field, max: number) => { const s = cellText(get(f)).replace(/\s+/g, ' '); if (s.length > max) err(f, `Tối đa ${max} ký tự`, s); return s; };
    const fullName = txt('fullName', 120); if (!fullName) err('fullName', 'Bắt buộc');
    const dobRaw = get('dob'); const dob = parseDate(dobRaw);
    if (!cellText(dobRaw)) err('dob', 'Bắt buộc'); else if (!dob) err('dob', 'Ngày không hợp lệ (dd/mm/yyyy)', dobRaw);
    else if (dob > today) err('dob', 'Ngày sinh ở tương lai', dobRaw); else if (dob < minDob) err('dob', 'Bé quá 8 tuổi, kiểm tra lại ngày sinh', dobRaw);
    const gRaw = cellText(get('gender')); const g = gender(gRaw); if (!gRaw) err('gender', 'Bắt buộc'); else if (!g) err('gender', 'Chỉ nhận Nam / Nữ', gRaw);
    const className = txt('className', 80); if (!className) err('className', 'Bắt buộc');
    const allergies = txt('allergies', 500) || null, healthNotes = txt('healthNotes', 1000) || null, address = txt('address', 300) || null;
    const enRaw = get('enrolledAt'); let enrolledAt: string | null = null;
    if (cellText(enRaw)) { enrolledAt = parseDate(enRaw); if (!enrolledAt) err('enrolledAt', 'Ngày không hợp lệ (dd/mm/yyyy)', enRaw); else if (dob && enrolledAt < dob) err('enrolledAt', 'Ngày nhập học trước ngày sinh', enRaw); }
    const guardians: GuardianIn[] = [];
    for (const slot of [1, 2] as const) {
      const f = (k: 'Name' | 'Relation' | 'Phone' | 'CanPickup') => `g${slot}${k}` as Field;
      const name = txt(f('Name'), 120), rel = txt(f('Relation'), 40), phRaw = get(f('Phone')), pick = cellText(get(f('CanPickup')));
      const any = name || rel || cellText(phRaw) || pick;
      if (slot === 2 && !any) continue;
      if (!name) err(f('Name'), 'Bắt buộc');
      const phone = parsePhone(phRaw);
      if (!cellText(phRaw)) err(f('Phone'), 'Bắt buộc'); else if (!phone) err(f('Phone'), 'SĐT không hợp lệ (10 số, bắt đầu bằng 0)', phRaw);
      const canPickup = yesNo(pick); if (canPickup === null) err(f('CanPickup'), 'Chỉ nhận Có / Không', pick);
      if (phone) guardians.push({ slot, fullName: name, relation: rel || 'Phụ huynh', phone, canPickup: canPickup ?? true });
    }
    if (guardians.length === 2 && guardians[0].phone === guardians[1].phone) err('g2Phone', 'PH2 trùng SĐT với PH1', guardians[1].phone);
    rows.push({ row, fullName, dob: dob && dob <= today && dob >= minDob ? dob : null, gender: g, className, allergies, healthNotes, address, enrolledAt, guardians });
  }
  return { rows, errors, totalRows: raw.length, sheet: ws.name };
}

/** Temporary password: 10 chars, unambiguous alphabet, always letters + digits. */
export function tempPassword(): string {
  const L = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', A = L + D;
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = [pick(L), pick(L), pick(D), pick(D), ...Array.from({ length: 6 }, () => pick(A))];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** Best guess of the age group from a VN class name (used only when a class is auto-created). */
export const guessAgeGroup = (className: string) => {
  const k = norm(className);
  return k.startsWith('nha tre') ? '24-36 tháng' : k.startsWith('mam') ? '3-4 tuổi' : k.startsWith('choi') ? '4-5 tuổi' : k.startsWith('la') ? '5-6 tuổi' : 'Chưa xác định';
};
/** School year "2026-2027" (new year starts in August). */
export const schoolYearOf = (today: string) => { const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)); return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
