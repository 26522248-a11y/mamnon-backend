import { Body, Controller, Get, HttpCode, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { IsIn, IsOptional } from 'class-validator';
import * as ExcelJS from 'exceljs';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { todayStr } from '../common/dates';
import { recordAudit } from '../common/audit';
import { AppError } from '../common/errors';
import { Child, ClassRoom, Guardian, User } from '../database/entities';
import {
  buildTemplate, guessAgeGroup, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, nameKey, parseWorkbook, personKey, ParsedRow, RowError, schoolYearOf, tempPassword, XLSX_MIME,
} from './children-import';

export class ImportQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'], default: 'false', description: 'true: chỉ kiểm tra + xem trước, không ghi gì' }) @IsOptional() @IsIn(['true', 'false']) dryRun?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Lớp chưa có: true = tự tạo, false = báo lỗi. Mặc định env IMPORT_CREATE_CLASSES (false)' })
  @IsOptional() @IsIn(['true', 'false']) createClasses?: string;
}

/** Multipart field `confirmLinks` = JSON array of {row, guardian: 1|2} -> Set "row:guardian". 400 when malformed. */
export function parseConfirmLinks(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (raw == null || raw === '') return out;
  let v: unknown;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { v = undefined; }
  const bad = () => new AppError(400, 'VALIDATION_ERROR', 'confirmLinks phải là JSON dạng [{"row": 5, "guardian": 1}]');
  if (!Array.isArray(v) || v.length > 2 * MAX_IMPORT_ROWS) throw bad();
  for (const x of v) {
    const row = (x as any)?.row, guardian = (x as any)?.guardian;
    if (!Number.isInteger(row) || row < 2 || (guardian !== 1 && guardian !== 2)) throw bad();
    out.add(`${row}:${guardian}`);
  }
  return out;
}

/** Temp passwords for imported parents: cost 8 (they are single-use, mustChangePassword re-hashes at cost 10). */
const TEMP_HASH_COST = 8;

interface Plan {
  row: number; action: 'create' | 'skip_duplicate'; existingChildId?: string; existingChildStatus?: string;
  child: { fullName: string; dob: string; gender: 'M' | 'F'; className: string; classAction: 'existing' | 'create'; allergies: string | null; healthNotes: string | null; address: string | null; enrolledAt: string; photoConsent: boolean };
  guardians: { slot: 1 | 2; fullName: string; relation: string; phone: string; canPickup: boolean; account: 'create' | 'existing' | 'existing_inactive' | 'skip'; username: string; accountName?: string; linkConfirmed?: boolean }[];
}

@ApiTags('imports') @ApiBearerAuth()
@Controller('imports')
export class ImportsController {
  constructor(private ds: DataSource) {}

  @Get('children/template') @Roles('admin')
  async template(@Res() res: Response) {
    const buf = await buildTemplate();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="mau-nhap-hoc-sinh.xlsx"`);
    res.send(buf);
  }

  /**
   * Import children + guardians from the template. dryRun=true: validation + preview only.
   * Otherwise everything is written in ONE transaction, only if there is no row error (else 422 with the same report).
   */
  @Post('children') @Roles('admin') @HttpCode(200)
  @ApiConsumes('multipart/form-data') @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' },
    confirmLinks: { type: 'string', example: '[{"row":5,"guardian":2}]', description: 'JSON: các cặp (dòng Excel, PH1|PH2) được phép gắn vào tài khoản có sẵn dù khác tên (lỗi PHONE_NAME_MISMATCH)' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  async importChildren(@CurrentUser() u: AuthUser, @Query() q: ImportQuery, @UploadedFile() file?: Express.Multer.File, @Body() body?: Record<string, unknown>) {
    const today = todayStr();
    const confirm = parseConfirmLinks(body?.confirmLinks);
    const dryRun = q.dryRun === 'true';
    const createClasses = (q.createClasses ?? process.env.IMPORT_CREATE_CLASSES ?? 'false') === 'true';
    const parsed = await parseWorkbook(file?.buffer as Buffer, today);
    const options = { dryRun, createClasses, maxRows: MAX_IMPORT_ROWS };

    if (dryRun) {
      const a = await this.analyze(this.ds.manager, parsed.rows, parsed.errors, createClasses, today, confirm);
      return { ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: a.errors.length === 0, ...this.report(a) };
    }
    // hash temp passwords BEFORE the transaction (bcrypt dominates: ~20 ms each) so the serializable transaction stays short
    const pre = await this.analyze(this.ds.manager, parsed.rows, parsed.errors, createClasses, today, confirm);
    if (pre.errors.length) throw new AppError(422, 'IMPORT_INVALID', `Có ${pre.errors.length} lỗi; chưa nhập gì. Sửa file rồi thử lại (dùng dryRun=true để kiểm tra).`,
      { ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: false, ...this.report(pre) });
    const hashed = new Map<string, { password: string; hash: string }>();
    for (const p of pre.plans) if (p.action === 'create') for (const g of p.guardians) if (g.account === 'create' && !hashed.has(g.phone)) {
      const password = tempPassword();
      hashed.set(g.phone, { password, hash: await bcrypt.hash(password, TEMP_HASH_COST) });
    }
    return this.ds.transaction('SERIALIZABLE', async (m) => {
      const a = await this.analyze(m, parsed.rows, parsed.errors, createClasses, today, confirm);
      if (a.errors.length) throw new AppError(422, 'IMPORT_INVALID', `Có ${a.errors.length} lỗi; chưa nhập gì. Sửa file rồi thử lại (dùng dryRun=true để kiểm tra).`,
        { ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: false, ...this.report(a) });
      // classes
      const classId = new Map(a.classes);
      const classesCreated: string[] = [];
      for (const name of a.classesToCreate) {
        const c = await m.save(ClassRoom, m.create(ClassRoom, { name, ageGroup: guessAgeGroup(name), schoolYear: schoolYearOf(today), room: null, capacity: null }));
        classId.set(nameKey(name), c.id); classesCreated.push(name);
      }
      // parent accounts (one per phone)
      const accounts = new Map<string, { userId: string; created: boolean; active: boolean; name: string; password?: string; children: string[] }>();
      for (const p of a.plans) for (const g of p.guardians) {
        if (p.action !== 'create') continue;
        let acc = accounts.get(g.phone);
        if (!acc) {
          const ex = a.users.get(g.phone);
          if (ex) acc = { userId: ex.id, created: false, active: ex.active, name: ex.name, children: [] };
          else {
            let h = hashed.get(g.phone);
            if (!h) { const pw = tempPassword(); h = { password: pw, hash: await bcrypt.hash(pw, TEMP_HASH_COST) }; }
            const password = h.password;
            const nu = await m.save(User, m.create(User, { username: g.phone, name: g.fullName, role: 'parent', phone: g.phone, isActive: true, mustChangePassword: true,
              passwordHash: h.hash }));
            acc = { userId: nu.id, created: true, active: true, name: g.fullName, password, children: [] };
          }
          accounts.set(g.phone, acc);
        }
        acc.children.push(`${p.child.fullName} (${p.child.className})`);
      }
      // children + guardians
      const results: { row: number; result: 'created' | 'skipped_duplicate'; childId: string; fullName: string; className: string; guardians: { fullName: string; phone: string; username: string; account: string }[] }[] = [];
      let guardiansCreated = 0;
      for (const p of a.plans) {
        if (p.action === 'skip_duplicate') { results.push({ row: p.row, result: 'skipped_duplicate', childId: p.existingChildId!, fullName: p.child.fullName, className: p.child.className, guardians: [] }); continue; }
        const c = await m.save(Child, m.create(Child, { fullName: p.child.fullName, dob: p.child.dob, gender: p.child.gender, classId: classId.get(nameKey(p.child.className))!,
          allergies: p.child.allergies, healthNotes: p.child.healthNotes, address: p.child.address, enrolledAt: p.child.enrolledAt, status: 'active',
          photoConsent: p.child.photoConsent, ...(p.child.photoConsent ? { photoConsentUpdatedAt: new Date(), photoConsentUpdatedBy: u.id } : {}) }));
        if (p.child.photoConsent) await recordAudit(m, u, { action: 'child.photo_consent', entityType: 'child', entityId: c.id, childId: c.id,
          before: { consent: false }, after: { consent: true, source: 'import' }, reason: `Nhập Excel dòng ${p.row}` });
        for (const g of p.guardians) {
          await m.save(Guardian, m.create(Guardian, { childId: c.id, fullName: g.fullName, relation: g.relation, phone: g.phone, canPickup: g.canPickup, userId: accounts.get(g.phone)!.userId }));
          guardiansCreated++;
        }
        results.push({ row: p.row, result: 'created', childId: c.id, fullName: p.child.fullName, className: p.child.className,
          guardians: p.guardians.map((g) => ({ fullName: g.fullName, phone: g.phone, username: g.phone, account: accounts.get(g.phone)!.created ? 'created' : 'existing' })) });
      }
      const created = [...accounts.entries()].filter(([, x]) => x.created);
      const resultFile = await this.resultXlsx(results, accounts, today);
      const imported = { children: results.filter((r) => r.result === 'created').length, guardians: guardiansCreated, parentAccountsCreated: created.length,
        parentAccountsLinked: accounts.size - created.length, classesCreated };
      const { summary } = this.report(a);
      return {
        ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: true,
        // same keys as the dryRun summary (what was planned) + what was actually written
        summary: { ...summary, childrenCreated: imported.children, guardiansCreated: imported.guardians, parentAccountsCreated: imported.parentAccountsCreated,
          parentAccountsLinked: imported.parentAccountsLinked, classesCreated, duplicatesSkipped: results.filter((r) => r.result === 'skipped_duplicate').length },
        imported,
        skippedDuplicates: results.filter((r) => r.result === 'skipped_duplicate').map((r) => ({ row: r.row, fullName: r.fullName, existingChildId: r.childId })),
        warnings: a.warnings, rows: results,
        /** Only copy of the temporary passwords – not stored anywhere, not returned again. */
        resultFile: { fileName: `ket-qua-nhap-hoc-sinh_${today}.xlsx`, mimeType: XLSX_MIME, base64: resultFile.toString('base64') },
        importedBy: u.id,
      };
    });
  }

  private report(a: Awaited<ReturnType<ImportsController['analyze']>>) {
    const create = a.plans.filter((p) => p.action === 'create');
    const phonesNew = new Set<string>(), phonesExisting = new Set<string>();
    for (const p of create) for (const g of p.guardians) (g.account === 'create' ? phonesNew : phonesExisting).add(g.phone);
    return {
      summary: {
        validRows: a.plans.length, errorRows: new Set(a.errors.map((e) => e.row)).size, errorCount: a.errors.length,
        childrenToCreate: create.length, duplicatesToSkip: a.plans.length - create.length,
        classesToCreate: a.classesToCreate, parentAccountsToCreate: phonesNew.size, parentAccountsToLink: phonesExisting.size,
        guardiansToCreate: create.reduce((s, p) => s + p.guardians.length, 0),
      },
      errors: a.errors, warnings: a.warnings, preview: a.plans,
    };
  }

  /** DB-aware validation + plan (dedupe children by name+dob, parents by phone, classes by name). */
  private async analyze(m: EntityManager, rows: ParsedRow[], parseErrors: RowError[], createClasses: boolean, today: string, confirm: Set<string> = new Set()) {
    const errors: RowError[] = [...parseErrors];
    const warnings: { row: number | null; message: string }[] = [];
    const classRows: { id: string; name: string; capacity: number | null; active: number }[] = await m.query(
      `SELECT cl.id, cl.name, cl.capacity, (SELECT COUNT(*)::int FROM children c WHERE c.class_id = cl.id AND c.status = 'active') AS active FROM classes cl`);
    const classes = new Map(classRows.map((c) => [nameKey(c.name), c.id]));
    const classesToCreate: string[] = [];
    const existingKids: { id: string; full_name: string; dob: string; status: string }[] = await m.query(`SELECT id, full_name, to_char(dob,'YYYY-MM-DD') AS dob, status FROM children`);
    const kidKey = (n: string, d: string) => `${nameKey(n)}|${d}`;
    const kidIndex = new Map(existingKids.map((k) => [kidKey(k.full_name, k.dob), k]));
    const phones = [...new Set(rows.flatMap((r) => r.guardians.map((g) => g.phone)))];
    const userRows: { id: string; username: string; name: string; role: string; phone: string | null; is_active: boolean }[] = phones.length
      ? await m.query(`SELECT id, username, name, role, phone, is_active FROM users WHERE username = ANY($1) OR phone = ANY($1)`, [phones]) : [];
    const users = new Map<string, { id: string; name: string; active: boolean }>();
    const staffPhones = new Map<string, string>();
    const staffSamePhone = new Map<string, string>();
    for (const p of phones) {
      const staff = userRows.find((x) => x.role !== 'parent' && x.phone === p && x.username !== p);
      if (staff) staffSamePhone.set(p, `${staff.name} (${staff.role})`);
      const byUsername = userRows.find((x) => x.username === p);
      const parents = userRows.filter((x) => x.role === 'parent' && (x.username === p || x.phone === p));
      if (byUsername && byUsername.role !== 'parent') staffPhones.set(p, byUsername.role);
      else if (byUsername) users.set(p, { id: byUsername.id, name: byUsername.name, active: byUsername.is_active });
      else if (parents.length === 1) users.set(p, { id: parents[0].id, name: parents[0].name, active: parents[0].is_active });
      else if (parents.length > 1) staffPhones.set(p, 'nhiều tài khoản phụ huynh');
    }
    // children already linked to the existing parent accounts (shown in the "will be linked" warning)
    const linkedKids = new Map<string, string[]>();
    const exIds = [...users.values()].map((x) => x.id);
    if (exIds.length) for (const k of await m.query(`SELECT g.user_id, c.full_name FROM guardians g JOIN children c ON c.id = g.child_id WHERE g.user_id = ANY($1) ORDER BY c.full_name`, [exIds]) as { user_id: string; full_name: string }[]) {
      const l = linkedKids.get(k.user_id) ?? []; if (!l.includes(k.full_name)) l.push(k.full_name); linkedKids.set(k.user_id, l);
    }
    const seenKids = new Map<string, number>();
    const phoneName = new Map<string, { name: string; row: number }>();
    const newPerClass = new Map<string, number>();
    const plans: Plan[] = [];
    const badRows = new Set(parseErrors.map((e) => e.row));
    // Every check runs on every row independently, so a row reports ALL its errors at once (field errors from parsing
    // + class / duplicate / staff-phone). Only rows without any error get a plan (preview).
    for (const r of rows) {
      let bad = badRows.has(r.row);
      const err = (column: string | null, field: any, message: string, value?: string, extra?: Partial<RowError>) => { errors.push({ row: r.row, column, field, value, message, ...extra }); bad = true; };
      const key = r.fullName && r.dob ? kidKey(r.fullName, r.dob) : null;
      if (key) {
        const dupInFile = seenKids.get(key);
        if (dupInFile) err('Họ tên bé *', 'fullName', `Trùng với dòng ${dupInFile} trong file (cùng họ tên + ngày sinh)`, r.fullName);
        else seenKids.set(key, r.row);
      }
      const ck = nameKey(r.className);
      let classAction: 'existing' | 'create' = 'existing';
      if (ck && !classes.has(ck)) {
        if (createClasses) classAction = 'create';
        else err('Lớp *', 'className', `Lớp "${r.className}" chưa có trong hệ thống (tạo lớp trước hoặc nhập với createClasses=true)`, r.className);
      }
      for (const g of r.guardians) {
        const col = `PH${g.slot} - SĐT ${g.slot === 1 ? '*' : ''}`.trim();
        if (staffPhones.has(g.phone)) { err(col, `g${g.slot}Phone`, `SĐT ${g.phone} trùng tài khoản ${staffPhones.get(g.phone)}; không dùng làm tài khoản phụ huynh được`, g.phone); continue; }
        if (!g.fullName) continue; // name missing: already a field error
        if (g.slot === 2 && r.guardians.some((o) => o.slot === 1 && o.phone === g.phone)) continue; // PH2 = PH1 phone: already a field error
        // SECURITY: never silently link a child to an account of a different person (that parent would see the child)
        const ex = users.get(g.phone);
        const confirmed = confirm.has(`${r.row}:${g.slot}`);
        if (ex) {
          if (personKey(ex.name) !== personKey(g.fullName) && !confirmed)
            err(col, `g${g.slot}Phone`, `SĐT ${g.phone} đang thuộc tài khoản phụ huynh "${ex.name}", khác tên "${g.fullName}". Kiểm tra lại SĐT; nếu đúng là cùng một người thì xác nhận gắn (confirmLinks)`, g.phone,
              { code: 'PHONE_NAME_MISMATCH', existingAccount: { userId: ex.id, name: ex.name, childrenCount: (linkedKids.get(ex.id) ?? []).length } });
          continue;
        }
        // same new phone, different names across rows -> one account would be shared by two people
        const seen = phoneName.get(g.phone);
        if (!seen) phoneName.set(g.phone, { name: g.fullName, row: r.row });
        else if (seen.row !== r.row && personKey(seen.name) !== personKey(g.fullName) && !confirmed)
          err(col, `g${g.slot}Phone`, `SĐT ${g.phone} đã dùng cho "${seen.name}" ở dòng ${seen.row}, khác tên "${g.fullName}" (một SĐT = một tài khoản). Kiểm tra lại SĐT; nếu đúng là cùng một người thì xác nhận gắn (confirmLinks)`, g.phone,
            { code: 'PHONE_NAME_MISMATCH', existingAccount: null, conflictRow: seen.row });
      }
      if (bad || !key || !r.dob || !r.gender) continue; // has errors: not in the preview
      const existing = kidIndex.get(key);
      if (!existing && classAction === 'create' && !classesToCreate.some((x) => nameKey(x) === ck)) classesToCreate.push(r.className);
      if (!existing) for (const g of r.guardians) {
        if (staffSamePhone.has(g.phone) && !users.has(g.phone)) warnings.push({ row: r.row, message: `SĐT ${g.phone} trùng SĐT của nhân viên ${staffSamePhone.get(g.phone)}; vẫn tạo tài khoản phụ huynh riêng (tên đăng nhập ${g.phone})` });
        const seen = phoneName.get(g.phone);
        if (seen && seen.row !== r.row && personKey(seen.name) !== personKey(g.fullName)) warnings.push({ row: r.row, message: `SĐT ${g.phone}: tên "${g.fullName}" khác dòng ${seen.row} ("${seen.name}"); đã xác nhận dùng chung một tài khoản` });
        const ex = users.get(g.phone);
        if (ex) {
          const kids = linkedKids.get(ex.id) ?? [];
          const same = personKey(ex.name) === personKey(g.fullName);
          warnings.push({ row: r.row, message: `SĐT ${g.phone} đã có tài khoản phụ huynh "${ex.name}"${same ? '' : ` (khác tên "${g.fullName}", đã xác nhận gắn)`}; bé sẽ được gắn vào tài khoản này. Tài khoản đang có ${kids.length ? `bé: ${kids.join(', ')}` : 'chưa có bé nào'}` });
        }
        if (ex && !ex.active) warnings.push({ row: r.row, message: `Tài khoản phụ huynh ${g.phone} đang bị khoá` });
      }
      if (existing) warnings.push({ row: r.row, message: `Bé "${r.fullName}" (${r.dob.split('-').reverse().join('/')}) đã có trong hệ thống${existing.status === 'withdrawn' ? ' (đã nghỉ học)' : ''}; bỏ qua dòng này` });
      else if (classAction === 'existing') newPerClass.set(ck, (newPerClass.get(ck) ?? 0) + 1);
      plans.push({
        row: r.row, action: existing ? 'skip_duplicate' : 'create', ...(existing ? { existingChildId: existing.id, existingChildStatus: existing.status } : {}),
        child: { fullName: r.fullName, dob: r.dob, gender: r.gender, className: classAction === 'existing' ? classRows.find((c) => nameKey(c.name) === ck)!.name : r.className, classAction,
          allergies: r.allergies, healthNotes: r.healthNotes, address: r.address, enrolledAt: r.enrolledAt ?? today, photoConsent: r.photoConsent },
        // skipped duplicate: nothing is created or linked for its guardians
        guardians: r.guardians.map((g) => {
          const ex = users.get(g.phone);
          return { ...g, username: g.phone, account: existing ? 'skip' : ex ? (ex.active ? 'existing' : 'existing_inactive') : 'create',
            ...(ex && !existing ? { accountName: ex.name, ...(personKey(ex.name) !== personKey(g.fullName) ? { linkConfirmed: true } : {}) } : {}) };
        }),
      });
    }
    for (const c of classRows) {
      const add = newPerClass.get(nameKey(c.name)) ?? 0;
      if (add && c.capacity && c.active + add > c.capacity) warnings.push({ row: null, message: `Lớp ${c.name}: ${c.active} + ${add} bé mới = ${c.active + add}, vượt sức chứa ${c.capacity}` });
    }
    errors.sort((x, y) => x.row - y.row);
    return { errors, warnings, plans, classes, classesToCreate, users };
  }

  /**
   * Printable result file. Sheet 1 = ONLY newly created parent accounts (one row per account, every row has a temp password),
   * header in row 1 and nothing but data below it (the warning is in the page header/footer + the "Lưu ý" sheet), so it can be
   * printed / cut into slips as is. Existing accounts the children were linked to are on their own sheet without passwords.
   */
  private async resultXlsx(results: { row: number; result: string; childId: string; fullName: string; className: string; guardians: { fullName: string; phone: string; account: string }[] }[],
    accounts: Map<string, { created: boolean; active: boolean; name: string; password?: string; children: string[] }>, today: string) {
    const WARN = 'Mật khẩu tạm chỉ có trong file này, không lấy lại được. Phụ huynh phải đổi mật khẩu khi đăng nhập lần đầu. Giữ file kín, xoá sau khi đã phát cho phụ huynh.';
    const wb = new ExcelJS.Workbook();
    const bold = (ws: ExcelJS.Worksheet) => { ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
    const kids = (a: { children: string[] }) => [...new Set(a.children)].join(', ');
    const pw = wb.addWorksheet('Mật khẩu tạm (in phát)', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' },
      headerFooter: { oddHeader: `&L&B${WARN.split('.')[0]}.&R${today}`, oddFooter: '&LĐổi mật khẩu khi đăng nhập lần đầu&RTrang &P/&N' },
    });
    pw.columns = [{ header: 'STT', key: 'i', width: 6 }, { header: 'Tên đăng nhập (SĐT)', key: 'u', width: 20 }, { header: 'Họ tên phụ huynh', key: 'n', width: 26 },
      { header: 'Mật khẩu tạm', key: 'p', width: 16 }, { header: 'Con (lớp)', key: 'c', width: 50 }];
    let i = 0;
    for (const [phone, a] of accounts) if (a.created && a.password) pw.addRow({ i: ++i, u: phone, n: a.name, p: a.password, c: kids(a) });
    pw.getColumn('u').numFmt = '@'; pw.getColumn('p').font = { name: 'Consolas', size: 12, bold: true }; pw.getCell('D1').font = { bold: true };
    pw.getColumn('c').alignment = { wrapText: true, vertical: 'top' };
    bold(pw);
    const ex = wb.addWorksheet('Tài khoản đã có');
    ex.columns = [{ header: 'Tên đăng nhập (SĐT)', key: 'u', width: 20 }, { header: 'Họ tên', key: 'n', width: 26 }, { header: 'Mật khẩu', key: 's', width: 44 }, { header: 'Con mới gắn (lớp)', key: 'c', width: 50 }];
    for (const [phone, a] of accounts) if (!a.created) ex.addRow({ u: phone, n: a.name, s: a.active ? 'Tài khoản đã có – dùng mật khẩu cũ' : 'Tài khoản đã có – dùng mật khẩu cũ (đang bị khoá, cần mở khoá)', c: kids(a) });
    bold(ex);
    const rs = wb.addWorksheet('Kết quả từng dòng');
    rs.columns = [{ header: 'Dòng', key: 'r', width: 7 }, { header: 'Họ tên bé', key: 'n', width: 26 }, { header: 'Lớp', key: 'l', width: 12 },
      { header: 'Kết quả', key: 'k', width: 26 }, { header: 'Phụ huynh', key: 'g', width: 50 }, { header: 'Mã bé', key: 'i', width: 38 }];
    for (const r of results) rs.addRow({ r: r.row, n: r.fullName, l: r.className, k: r.result === 'created' ? 'Đã thêm' : 'Bỏ qua – đã có trong hệ thống',
      g: r.guardians.map((g) => `${g.fullName} (${g.phone}${g.account === 'created' ? ', tài khoản mới' : ', tài khoản đã có'})`).join('; '), i: r.childId });
    bold(rs);
    const note = wb.addWorksheet('Lưu ý');
    note.columns = [{ width: 110 }];
    [WARN, `Sheet "Mật khẩu tạm (in phát)": ${i} tài khoản mới, mỗi dòng một phụ huynh (một SĐT), in và cắt phát cho từng phụ huynh.`,
      `Sheet "Tài khoản đã có": ${accounts.size - i} tài khoản đã có từ trước, bé được gắn thêm vào; phụ huynh dùng mật khẩu cũ (không có mật khẩu mới).`,
      'Sheet "Kết quả từng dòng": kết quả từng dòng của file nhập.'].forEach((t, k) => { const r = note.addRow([t]); r.getCell(1).alignment = { wrapText: true }; if (!k) r.font = { bold: true, color: { argb: 'FFC00000' } }; });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
