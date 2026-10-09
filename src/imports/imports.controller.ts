import { Controller, Get, HttpCode, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
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
import { AppError } from '../common/errors';
import { Child, ClassRoom, Guardian, User } from '../database/entities';
import {
  buildTemplate, guessAgeGroup, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, nameKey, parseWorkbook, ParsedRow, RowError, schoolYearOf, tempPassword, XLSX_MIME,
} from './children-import';

export class ImportQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'], default: 'false', description: 'true: chỉ kiểm tra + xem trước, không ghi gì' }) @IsOptional() @IsIn(['true', 'false']) dryRun?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Lớp chưa có: true = tự tạo, false = báo lỗi. Mặc định env IMPORT_CREATE_CLASSES (false)' })
  @IsOptional() @IsIn(['true', 'false']) createClasses?: string;
}

/** Temp passwords for imported parents: cost 8 (they are single-use, mustChangePassword re-hashes at cost 10). */
const TEMP_HASH_COST = 8;

interface Plan {
  row: number; action: 'create' | 'skip_duplicate'; existingChildId?: string; existingChildStatus?: string;
  child: { fullName: string; dob: string; gender: 'M' | 'F'; className: string; classAction: 'existing' | 'create'; allergies: string | null; healthNotes: string | null; address: string | null; enrolledAt: string };
  guardians: { slot: 1 | 2; fullName: string; relation: string; phone: string; canPickup: boolean; account: 'create' | 'existing' | 'existing_inactive' | 'skip'; username: string }[];
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
  @ApiConsumes('multipart/form-data') @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  async importChildren(@CurrentUser() u: AuthUser, @Query() q: ImportQuery, @UploadedFile() file?: Express.Multer.File) {
    const today = todayStr();
    const dryRun = q.dryRun === 'true';
    const createClasses = (q.createClasses ?? process.env.IMPORT_CREATE_CLASSES ?? 'false') === 'true';
    const parsed = await parseWorkbook(file?.buffer as Buffer, today);
    const options = { dryRun, createClasses, maxRows: MAX_IMPORT_ROWS };

    if (dryRun) {
      const a = await this.analyze(this.ds.manager, parsed.rows, parsed.errors, createClasses, today);
      return { ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: a.errors.length === 0, ...this.report(a) };
    }
    // hash temp passwords BEFORE the transaction (bcrypt dominates: ~20 ms each) so the serializable transaction stays short
    const pre = await this.analyze(this.ds.manager, parsed.rows, parsed.errors, createClasses, today);
    if (pre.errors.length) throw new AppError(422, 'IMPORT_INVALID', `Có ${pre.errors.length} lỗi; chưa nhập gì. Sửa file rồi thử lại (dùng dryRun=true để kiểm tra).`,
      { ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: false, ...this.report(pre) });
    const hashed = new Map<string, { password: string; hash: string }>();
    for (const p of pre.plans) if (p.action === 'create') for (const g of p.guardians) if (g.account === 'create' && !hashed.has(g.phone)) {
      const password = tempPassword();
      hashed.set(g.phone, { password, hash: await bcrypt.hash(password, TEMP_HASH_COST) });
    }
    return this.ds.transaction('SERIALIZABLE', async (m) => {
      const a = await this.analyze(m, parsed.rows, parsed.errors, createClasses, today);
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
      const accounts = new Map<string, { userId: string; created: boolean; name: string; password?: string; children: string[] }>();
      for (const p of a.plans) for (const g of p.guardians) {
        if (p.action !== 'create') continue;
        let acc = accounts.get(g.phone);
        if (!acc) {
          const ex = a.users.get(g.phone);
          if (ex) acc = { userId: ex.id, created: false, name: ex.name, children: [] };
          else {
            let h = hashed.get(g.phone);
            if (!h) { const pw = tempPassword(); h = { password: pw, hash: await bcrypt.hash(pw, TEMP_HASH_COST) }; }
            const password = h.password;
            const nu = await m.save(User, m.create(User, { username: g.phone, name: g.fullName, role: 'parent', phone: g.phone, isActive: true, mustChangePassword: true,
              passwordHash: h.hash }));
            acc = { userId: nu.id, created: true, name: g.fullName, password, children: [] };
          }
          accounts.set(g.phone, acc);
        }
        acc.children.push(p.child.fullName);
      }
      // children + guardians
      const results: { row: number; result: 'created' | 'skipped_duplicate'; childId: string; fullName: string; className: string; guardians: { fullName: string; phone: string; username: string; account: string }[] }[] = [];
      let guardiansCreated = 0;
      for (const p of a.plans) {
        if (p.action === 'skip_duplicate') { results.push({ row: p.row, result: 'skipped_duplicate', childId: p.existingChildId!, fullName: p.child.fullName, className: p.child.className, guardians: [] }); continue; }
        const c = await m.save(Child, m.create(Child, { fullName: p.child.fullName, dob: p.child.dob, gender: p.child.gender, classId: classId.get(nameKey(p.child.className))!,
          allergies: p.child.allergies, healthNotes: p.child.healthNotes, address: p.child.address, enrolledAt: p.child.enrolledAt, status: 'active' }));
        for (const g of p.guardians) {
          await m.save(Guardian, m.create(Guardian, { childId: c.id, fullName: g.fullName, relation: g.relation, phone: g.phone, canPickup: g.canPickup, userId: accounts.get(g.phone)!.userId }));
          guardiansCreated++;
        }
        results.push({ row: p.row, result: 'created', childId: c.id, fullName: p.child.fullName, className: p.child.className,
          guardians: p.guardians.map((g) => ({ fullName: g.fullName, phone: g.phone, username: g.phone, account: accounts.get(g.phone)!.created ? 'created' : 'existing' })) });
      }
      const created = [...accounts.entries()].filter(([, x]) => x.created);
      const resultFile = await this.resultXlsx(results, accounts);
      return {
        ...options, sheet: parsed.sheet, totalRows: parsed.totalRows, ok: true,
        imported: { children: results.filter((r) => r.result === 'created').length, guardians: guardiansCreated, parentAccountsCreated: created.length,
          parentAccountsLinked: accounts.size - created.length, classesCreated },
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
  private async analyze(m: EntityManager, rows: ParsedRow[], parseErrors: RowError[], createClasses: boolean, today: string) {
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
    const seenKids = new Map<string, number>();
    const phoneName = new Map<string, { name: string; row: number }>();
    const newPerClass = new Map<string, number>();
    const plans: Plan[] = [];
    const badRows = new Set(parseErrors.map((e) => e.row));
    // Every check runs on every row independently, so a row reports ALL its errors at once (field errors from parsing
    // + class / duplicate / staff-phone). Only rows without any error get a plan (preview).
    for (const r of rows) {
      let bad = badRows.has(r.row);
      const err = (column: string | null, field: any, message: string, value?: string) => { errors.push({ row: r.row, column, field, value, message }); bad = true; };
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
        if (staffPhones.has(g.phone)) err(col, `g${g.slot}Phone`, `SĐT ${g.phone} trùng tài khoản ${staffPhones.get(g.phone)}; không dùng làm tài khoản phụ huynh được`, g.phone);
      }
      if (bad || !key || !r.dob || !r.gender) continue; // has errors: not in the preview
      const existing = kidIndex.get(key);
      if (!existing && classAction === 'create' && !classesToCreate.some((x) => nameKey(x) === ck)) classesToCreate.push(r.className);
      if (!existing) for (const g of r.guardians) {
        if (staffSamePhone.has(g.phone) && !users.has(g.phone)) warnings.push({ row: r.row, message: `SĐT ${g.phone} trùng SĐT của nhân viên ${staffSamePhone.get(g.phone)}; vẫn tạo tài khoản phụ huynh riêng (tên đăng nhập ${g.phone})` });
        const seen = phoneName.get(g.phone);
        if (seen && nameKey(seen.name) !== nameKey(g.fullName)) warnings.push({ row: r.row, message: `SĐT ${g.phone}: tên "${g.fullName}" khác dòng ${seen.row} ("${seen.name}"); dùng chung một tài khoản` });
        else if (!seen) phoneName.set(g.phone, { name: g.fullName, row: r.row });
        const ex = users.get(g.phone);
        if (ex && nameKey(ex.name) !== nameKey(g.fullName)) warnings.push({ row: r.row, message: `SĐT ${g.phone} đã có tài khoản phụ huynh "${ex.name}"; bé sẽ được gắn vào tài khoản này` });
        if (ex && !ex.active) warnings.push({ row: r.row, message: `Tài khoản phụ huynh ${g.phone} đang bị khoá` });
      }
      if (existing) warnings.push({ row: r.row, message: `Bé "${r.fullName}" (${r.dob.split('-').reverse().join('/')}) đã có trong hệ thống${existing.status === 'withdrawn' ? ' (đã nghỉ học)' : ''}; bỏ qua dòng này` });
      else if (classAction === 'existing') newPerClass.set(ck, (newPerClass.get(ck) ?? 0) + 1);
      plans.push({
        row: r.row, action: existing ? 'skip_duplicate' : 'create', ...(existing ? { existingChildId: existing.id, existingChildStatus: existing.status } : {}),
        child: { fullName: r.fullName, dob: r.dob, gender: r.gender, className: classAction === 'existing' ? classRows.find((c) => nameKey(c.name) === ck)!.name : r.className, classAction,
          allergies: r.allergies, healthNotes: r.healthNotes, address: r.address, enrolledAt: r.enrolledAt ?? today },
        // skipped duplicate: nothing is created or linked for its guardians
        guardians: r.guardians.map((g) => ({ ...g, username: g.phone, account: existing ? 'skip' : users.has(g.phone) ? (users.get(g.phone)!.active ? 'existing' : 'existing_inactive') : 'create' })),
      });
    }
    for (const c of classRows) {
      const add = newPerClass.get(nameKey(c.name)) ?? 0;
      if (add && c.capacity && c.active + add > c.capacity) warnings.push({ row: null, message: `Lớp ${c.name}: ${c.active} + ${add} bé mới = ${c.active + add}, vượt sức chứa ${c.capacity}` });
    }
    errors.sort((x, y) => x.row - y.row);
    return { errors, warnings, plans, classes, classesToCreate, users };
  }

  private async resultXlsx(results: { row: number; result: string; childId: string; fullName: string; className: string; guardians: { fullName: string; phone: string; account: string }[] }[],
    accounts: Map<string, { created: boolean; name: string; password?: string; children: string[] }>) {
    const wb = new ExcelJS.Workbook();
    const acc = wb.addWorksheet('Tài khoản phụ huynh');
    acc.columns = [{ header: 'Tên đăng nhập (SĐT)', key: 'u', width: 20 }, { header: 'Họ tên', key: 'n', width: 24 }, { header: 'Mật khẩu tạm', key: 'p', width: 16 },
      { header: 'Tài khoản', key: 's', width: 16 }, { header: 'Con', key: 'c', width: 40 }];
    for (const [phone, a] of accounts) acc.addRow({ u: phone, n: a.name, p: a.password ?? '(đã có – giữ mật khẩu cũ)', s: a.created ? 'Mới tạo' : 'Đã có', c: [...new Set(a.children)].join(', ') });
    acc.getRow(1).font = { bold: true };
    acc.addRow([]);
    acc.addRow(['Mật khẩu tạm chỉ có trong file này. Phụ huynh phải đổi mật khẩu khi đăng nhập lần đầu. Giữ file kín, xoá sau khi đã phát cho phụ huynh.']).font = { italic: true, color: { argb: 'FFC00000' } };
    const rs = wb.addWorksheet('Kết quả từng dòng');
    rs.columns = [{ header: 'Dòng', key: 'r', width: 7 }, { header: 'Họ tên bé', key: 'n', width: 26 }, { header: 'Lớp', key: 'l', width: 12 },
      { header: 'Kết quả', key: 'k', width: 26 }, { header: 'Phụ huynh', key: 'g', width: 50 }, { header: 'Mã bé', key: 'i', width: 38 }];
    for (const r of results) rs.addRow({ r: r.row, n: r.fullName, l: r.className, k: r.result === 'created' ? 'Đã thêm' : 'Bỏ qua – đã có trong hệ thống',
      g: r.guardians.map((g) => `${g.fullName} (${g.phone}${g.account === 'created' ? ', tài khoản mới' : ''})`).join('; '), i: r.childId });
    rs.getRow(1).font = { bold: true };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
