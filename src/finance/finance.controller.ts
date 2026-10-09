import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { DataSource, EntityManager } from 'typeorm';
import { recordAudit } from '../common/audit';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { contentDisposition, contentTypeOf, decodeOriginalName, detectImage, keyOf, removeImage, saveImage, sendStored } from '../common/upload';
import { storage } from '../common/storage';
import { FinanceCategory, FinanceEntry, User } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';

/** Expenses above this amount (VND) recorded by the accountant wait for admin (BGH) approval. */
export const APPROVAL_LIMIT = Number(process.env.FINANCE_APPROVAL_LIMIT || 10_000_000);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_RECEIPT = 5 * 1024 * 1024;
const receiptUpload = { storage: memoryStorage(), limits: { fileSize: MAX_RECEIPT, files: 1 } };
const METHOD = { cash: 'tiền mặt', transfer: 'chuyển khoản' } as const;

const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { from: `${month}-01`, toExcl: `${next}-01`, prev };
};
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';
const toInt = ({ value }: { value: unknown }) => (value === '' || value == null ? value : Number(value));

class MonthQuery {
  @ApiPropertyOptional({ example: '2026-10', description: 'Mặc định tháng hiện tại' }) @IsOptional() @Matches(MONTH_RE, { message: 'month: YYYY-MM' }) month?: string;
}
class TxnQuery extends MonthQuery {
  @ApiPropertyOptional({ enum: ['in', 'out'] }) @IsOptional() @IsIn(['in', 'out']) kind?: 'in' | 'out';
  @ApiPropertyOptional({ enum: ['approved', 'pending', 'rejected', 'void'] }) @IsOptional() @IsIn(['approved', 'pending', 'rejected', 'void']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
}
class CategoryDto {
  @ApiProperty({ enum: ['in', 'out'] }) @IsIn(['in', 'out']) kind!: 'in' | 'out';
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}
class CategoryPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() isActive?: boolean;
}
export class EntryDto {
  @ApiPropertyOptional({ enum: ['in', 'out'], default: 'out', description: 'Học phí KHÔNG nhập tay – tự cộng từ phiếu thu' }) @IsOptional() @IsIn(['in', 'out']) kind?: 'in' | 'out';
  @ApiProperty({ example: '2026-10-09' }) @IsDateString() date!: string;
  @ApiProperty({ example: 'Mua rau, thịt tuần 2' }) @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @ApiProperty({ example: 6200000 }) @Transform(toInt) @IsInt() @Min(1000) @Max(10_000_000_000) amount!: number;
  @ApiProperty() @IsUUID() categoryId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class DecisionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Receipt: JPG/PNG/HEIC (stored as image) or PDF, checked by content. */
async function saveReceipt(file?: Express.Multer.File): Promise<{ key: string; name: string }> {
  if (!file?.buffer?.length) throw BadRequest('Thiếu file hoá đơn', 'INVALID_FILE');
  const name = (decodeOriginalName(file.originalname) || 'hoa-don').slice(0, 200); // B29: UTF-8, not latin1
  if (file.buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    const key = `${crypto.randomUUID()}.pdf`;
    await storage().put(key, file.buffer, contentTypeOf(key)); // B27
    return { key, name };
  }
  if (!detectImage(file.buffer)) throw BadRequest('Hoá đơn phải là ảnh JPG/PNG/HEIC hoặc PDF', 'INVALID_FILE');
  return { key: await saveImage(file, 'document'), name }; // B31: image receipts resized to 2048px, PDFs untouched
}

@ApiTags('finance') @ApiBearerAuth()
@Controller('finance')
@Roles('admin', 'accountant')
export class FinanceController {
  constructor(private ds: DataSource, private notify: NotificationsService) {}

  // ─────────────── categories ───────────────
  @Get('categories')
  async categories(@Query('includeInactive') all?: string) {
    const items = await this.ds.getRepository(FinanceCategory).find({ where: all === 'true' ? {} : { isActive: true }, order: { kind: 'ASC', sortOrder: 'ASC', name: 'ASC' } });
    return { items };
  }

  @Post('categories') @Roles('admin')
  async createCategory(@CurrentUser() u: AuthUser, @Body() dto: CategoryDto) {
    const repo = this.ds.getRepository(FinanceCategory);
    if (await repo.exist({ where: { kind: dto.kind, name: dto.name.trim() } })) throw new AppError(409, 'DUPLICATE', 'Nhóm đã tồn tại');
    return this.ds.transaction(async (m) => {
      const c = await m.getRepository(FinanceCategory).save({ kind: dto.kind, name: dto.name.trim(), sortOrder: dto.sortOrder ?? 50 });
      await recordAudit(m, u, { action: 'finance_category.create', entityType: 'finance_category', entityId: c.id, before: null, after: { kind: c.kind, name: c.name }, targetLabel: c.name });
      return c;
    });
  }

  @Patch('categories/:id') @Roles('admin')
  async patchCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryPatchDto) {
    return this.ds.transaction(async (m) => {
      const c = await m.getRepository(FinanceCategory).findOneBy({ id });
      if (!c) throw NotFound('Không tìm thấy nhóm');
      const before = { name: c.name, sortOrder: c.sortOrder, isActive: c.isActive };
      if (dto.name !== undefined) c.name = dto.name.trim();
      if (dto.sortOrder !== undefined) c.sortOrder = dto.sortOrder;
      if (dto.isActive !== undefined) c.isActive = dto.isActive;
      await m.getRepository(FinanceCategory).save(c);
      await recordAudit(m, u, { action: 'finance_category.update', entityType: 'finance_category', entityId: c.id, before, after: { name: c.name, sortOrder: c.sortOrder, isActive: c.isActive }, targetLabel: c.name });
      return c;
    });
  }

  // ─────────────── summary & transactions ───────────────
  private async feeIncome(from: string, toExcl: string) {
    return this.ds.query(
      `SELECT (p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS date, p.method, COUNT(DISTINCT p.child_id)::int AS children, COUNT(*)::int AS n, SUM(p.amount)::bigint AS amount
         FROM payments p WHERE p.paid_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AND p.paid_at < ($2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [from, toExcl]) as Promise<{ date: string; method: 'cash' | 'transfer'; children: number; n: number; amount: string }[]>;
  }
  private async payouts(from: string, toExcl: string) {
    return this.ds.query(
      `SELECT (r.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS date, COUNT(*)::int AS n, SUM(r.amount)::bigint AS amount
         FROM refund_payouts r WHERE r.paid_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh') AND r.paid_at < ($2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        GROUP BY 1 ORDER BY 1 DESC`, [from, toExcl]) as Promise<{ date: string; n: number; amount: string }[]>;
  }
  private async totals(month: string) {
    const { from, toExcl } = monthRange(month);
    const [fees, pay, manual] = await Promise.all([
      this.feeIncome(from, toExcl), this.payouts(from, toExcl),
      this.ds.query(`SELECT e.kind, e.category_id AS "categoryId", c.name, SUM(e.amount)::bigint AS amount FROM finance_entries e JOIN finance_categories c ON c.id = e.category_id
                      WHERE e.status = 'approved' AND e.date >= $1 AND e.date < $2 GROUP BY 1, 2, 3`, [from, toExcl]) as Promise<{ kind: 'in' | 'out'; categoryId: string; name: string; amount: string }[]>,
    ]);
    const feeIn = fees.reduce((s, r) => s + Number(r.amount), 0);
    const payOut = pay.reduce((s, r) => s + Number(r.amount), 0);
    const otherIn = manual.filter((r) => r.kind === 'in').reduce((s, r) => s + Number(r.amount), 0);
    const groups = manual.filter((r) => r.kind === 'out').map((r) => ({ categoryId: r.categoryId, name: r.name, amount: Number(r.amount) }));
    if (payOut) groups.push({ categoryId: null as unknown as string, name: 'Hoàn tiền phụ huynh', amount: payOut });
    groups.sort((a, b) => b.amount - a.amount);
    const totalOut = groups.reduce((s, g) => s + g.amount, 0);
    return { feeIn, otherIn, totalIn: feeIn + otherIn, totalOut, net: feeIn + otherIn - totalOut, groups,
      inGroups: [{ categoryId: null, name: 'Học phí', amount: feeIn, auto: true }, ...manual.filter((r) => r.kind === 'in').map((r) => ({ categoryId: r.categoryId, name: r.name, amount: Number(r.amount), auto: false }))] };
  }

  @Get('summary')
  @ApiOperation({ summary: 'Tổng thu (học phí tự cộng từ phiếu thu + thu khác), tổng chi (đã duyệt + hoàn tiền phụ huynh), chênh lệch, % so tháng trước, chi theo nhóm, khoản chờ duyệt' })
  async summary(@Query() q: MonthQuery) {
    const month = q.month ?? todayStr().slice(0, 7);
    const [cur, prev, pending] = await Promise.all([
      this.totals(month), this.totals(monthRange(month).prev),
      this.ds.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::bigint AS amount FROM finance_entries WHERE status = 'pending' AND to_char(date, 'YYYY-MM') = $1`, [month]),
    ]);
    const pct = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);
    return {
      month, approvalLimit: APPROVAL_LIMIT,
      totalIn: cur.totalIn, totalOut: cur.totalOut, net: cur.net,
      in: { fees: cur.feeIn, other: cur.otherIn, groups: cur.inGroups },
      outGroups: cur.groups,
      prev: { month: monthRange(month).prev, totalIn: prev.totalIn, totalOut: prev.totalOut, net: prev.net },
      change: { totalInPct: pct(cur.totalIn, prev.totalIn), totalOutPct: pct(cur.totalOut, prev.totalOut), netPct: pct(cur.net, prev.net) },
      pending: { count: pending[0].n, amount: Number(pending[0].amount) },
    };
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Giao dịch trong tháng: học phí (tự động, gộp theo ngày + hình thức), hoàn tiền phụ huynh (tự động), thu/chi nhập tay (mọi trạng thái; lọc status/kind/categoryId)' })
  async transactions(@Query() q: TxnQuery) {
    const month = q.month ?? todayStr().slice(0, 7);
    const { from, toExcl } = monthRange(month);
    const items: Record<string, unknown>[] = [];
    const autoWanted = !q.status || q.status === 'approved';
    if (autoWanted && !q.categoryId && q.kind !== 'out')
      for (const r of await this.feeIncome(from, toExcl))
        items.push({ id: `fee:${r.date}:${r.method}`, source: 'fees', auto: true, kind: 'in', date: r.date, title: `Học phí · ${r.children} bé (${METHOD[r.method] ?? r.method})`,
          amount: Number(r.amount), status: 'approved', category: { id: null, name: 'Học phí' }, count: r.n, hasReceipt: false });
    if (autoWanted && !q.categoryId && q.kind !== 'in')
      for (const r of await this.payouts(from, toExcl))
        items.push({ id: `payout:${r.date}`, source: 'payouts', auto: true, kind: 'out', date: r.date, title: `Hoàn tiền phụ huynh · ${r.n} phiếu chi`, amount: Number(r.amount), status: 'approved',
          category: { id: null, name: 'Hoàn tiền phụ huynh' }, count: r.n, hasReceipt: false });
    const qb = this.ds.getRepository(FinanceEntry).createQueryBuilder('e').leftJoinAndSelect('e.category', 'c').leftJoinAndSelect('e.creator', 'u').leftJoinAndSelect('e.decider', 'd')
      .where('e.date >= :f AND e.date < :t', { f: from, t: toExcl });
    if (q.kind) qb.andWhere('e.kind = :k', { k: q.kind });
    if (q.status) qb.andWhere('e.status = :s', { s: q.status });
    if (q.categoryId) qb.andWhere('e.category_id = :c', { c: q.categoryId });
    for (const e of await qb.getMany()) items.push(this.view(e));
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return { month, items };
  }

  @Get('entries/:id')
  async entry(@Param('id', ParseUUIDPipe) id: string) {
    return this.view(await this.load(this.ds.manager, id));
  }

  // ─────────────── entries ───────────────
  @Post('entries') @HttpCode(201)
  @ApiConsumes('multipart/form-data', 'application/json') @UseInterceptors(FileInterceptor('receipt', receiptUpload))
  @ApiOperation({ summary: `Ghi thu/chi (kèm hoá đơn tuỳ chọn – field "receipt"). Chi > ${APPROVAL_LIMIT.toLocaleString('vi-VN')}đ do kế toán ghi → chờ BGH duyệt (pending), chưa tính vào tổng.` })
  async create(@CurrentUser() u: AuthUser, @Body() dto: EntryDto, @Req() req: Request, @UploadedFile() file?: Express.Multer.File) {
    const kind = dto.kind ?? 'out';
    const cat = await this.ds.getRepository(FinanceCategory).findOneBy({ id: dto.categoryId });
    if (!cat || !cat.isActive) throw BadRequest('Nhóm thu/chi không hợp lệ', 'INVALID_CATEGORY');
    if (cat.kind !== kind) throw BadRequest(`Nhóm "${cat.name}" không dùng cho khoản ${kind === 'in' ? 'thu' : 'chi'}`, 'INVALID_CATEGORY');
    const date = dto.date.slice(0, 10);
    if (date > todayStr()) throw BadRequest('Không ghi cho ngày tương lai', 'DATE_IN_FUTURE');
    const requiresApproval = kind === 'out' && dto.amount > APPROVAL_LIMIT;
    const autoApproved = !requiresApproval || u.role === 'admin';
    const receipt = file ? await saveReceipt(file) : null;
    const saved = await this.ds.transaction(async (m) => {
      const e = await m.getRepository(FinanceEntry).save({
        kind, date, title: dto.title.trim(), amount: dto.amount, categoryId: cat.id, note: dto.note?.trim() || null, createdBy: u.id,
        status: autoApproved ? 'approved' : 'pending', requiresApproval, receiptKey: receipt?.key ?? null, receiptName: receipt?.name ?? null,
        ...(requiresApproval && autoApproved ? { decidedBy: u.id, decidedAt: new Date(), decisionNote: 'BGH tự ghi' } : {}),
      });
      await recordAudit(m, u, { action: `finance.${kind === 'in' ? 'income' : 'expense'}.create`, entityType: 'finance_entry', entityId: e.id, before: null,
        after: { kind, date, title: e.title, amount: e.amount, category: cat.name, status: e.status, receipt: !!receipt }, ip: req.ip ?? null, targetLabel: e.title });
      if (e.status === 'pending') {
        const admins = await m.getRepository(User).find({ where: { role: 'admin', isActive: true }, select: { id: true } });
        await this.notify.send(admins.map((a) => a.id), { type: 'finance_approval', refId: e.id, title: `Khoản chi chờ duyệt: ${e.amount.toLocaleString('vi-VN')}đ`,
          body: `${e.title} (${cat.name}) – ${u.name}`, data: { entryId: e.id, amount: e.amount } });
      }
      return e.id;
    });
    return this.view(await this.load(this.ds.manager, saved));
  }

  @Post('entries/:id/receipt') @HttpCode(200)
  @ApiConsumes('multipart/form-data') @UseInterceptors(FileInterceptor('receipt', receiptUpload))
  @ApiOperation({ summary: 'Đính kèm / thay hoá đơn (ảnh JPG/PNG/HEIC hoặc PDF, ≤ 5MB)' })
  async attach(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) {
    const e = await this.load(this.ds.manager, id);
    if (e.status === 'void') throw new AppError(409, 'ENTRY_VOID', 'Khoản đã huỷ');
    if (u.role !== 'admin' && e.createdBy !== u.id) throw Forbidden('Chỉ người ghi hoặc BGH được đính kèm hoá đơn');
    const r = await saveReceipt(file);
    const old = e.receiptKey;
    await this.ds.transaction(async (m) => {
      await m.getRepository(FinanceEntry).update(id, { receiptKey: r.key, receiptName: r.name });
      await recordAudit(m, u, { action: 'finance.receipt.attach', entityType: 'finance_entry', entityId: id, before: { receipt: old ? 'có' : null }, after: { receipt: r.name }, targetLabel: e.title });
    });
    if (old) await removeImage(old);
    return this.view(await this.load(this.ds.manager, id));
  }

  @Get('entries/:id/receipt')
  async receipt(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const e = await this.load(this.ds.manager, id);
    if (!e.receiptKey) throw NotFound('Khoản này chưa có hoá đơn');
    const name = e.receiptName || keyOf(e.receiptKey);
    await sendStored(res, e.receiptKey, 'Không tìm thấy file hoá đơn', { 'Content-Disposition': contentDisposition('inline', name) });
  }

  @Post('entries/:id/approve') @Roles('admin') @HttpCode(200)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.decide(u, id, 'approved', dto.note?.trim() || null);
  }

  @Post('entries/:id/reject') @Roles('admin') @HttpCode(200)
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    if (!dto.note?.trim()) throw BadRequest('Nhập lý do từ chối', 'NOTE_REQUIRED');
    return this.decide(u, id, 'rejected', dto.note.trim());
  }

  @Post('entries/:id/void') @HttpCode(200)
  @ApiOperation({ summary: 'Huỷ khoản (bắt buộc lý do). Kế toán chỉ huỷ khoản mình ghi khi còn chờ duyệt; BGH huỷ được mọi khoản.' })
  async void(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    if (!dto.note?.trim()) throw BadRequest('Nhập lý do huỷ', 'NOTE_REQUIRED');
    const e = await this.load(this.ds.manager, id);
    if (u.role !== 'admin' && !(e.createdBy === u.id && e.status === 'pending')) throw Forbidden('Chỉ BGH huỷ được khoản đã duyệt');
    return this.decide(u, id, 'void', dto.note.trim());
  }

  private async decide(u: AuthUser, id: string, status: 'approved' | 'rejected' | 'void', note: string | null) {
    await this.ds.transaction(async (m) => {
      const e = await m.getRepository(FinanceEntry).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!e) throw NotFound('Không tìm thấy khoản thu/chi');
      if (status === 'void' ? e.status === 'void' : e.status !== 'pending')
        throw new AppError(409, 'ALREADY_DECIDED', e.status === 'void' ? 'Khoản đã huỷ' : e.status === 'approved' ? 'Khoản đã được duyệt' : e.status === 'rejected' ? 'Khoản đã bị từ chối' : 'Khoản không ở trạng thái chờ duyệt');
      const before = { status: e.status };
      await m.getRepository(FinanceEntry).update(id, { status, decidedBy: u.id, decidedAt: new Date(), decisionNote: note });
      await recordAudit(m, u, { action: `finance.entry.${status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'void'}`, entityType: 'finance_entry', entityId: id,
        before, after: { status, amount: e.amount, title: e.title }, reason: note, targetLabel: e.title });
      if (status !== 'void' && e.createdBy && e.createdBy !== u.id)
        await this.notify.send([e.createdBy], { type: 'finance_decision', refId: id, title: status === 'approved' ? `BGH đã duyệt khoản chi: ${e.title}` : `BGH từ chối khoản chi: ${e.title}`,
          body: note ?? undefined, data: { entryId: id, status } });
    });
    return this.view(await this.load(this.ds.manager, id));
  }

  private async load(m: EntityManager, id: string) {
    const e = await m.getRepository(FinanceEntry).findOne({ where: { id }, relations: { category: true, creator: true, decider: true } });
    if (!e) throw NotFound('Không tìm thấy khoản thu/chi');
    return e;
  }

  private view = (e: FinanceEntry) => ({
    id: e.id, source: 'manual', auto: false, kind: e.kind, date: e.date, title: e.title, amount: e.amount, status: e.status, requiresApproval: e.requiresApproval,
    pending: e.status === 'pending', category: e.category ? { id: e.category.id, name: e.category.name } : { id: e.categoryId, name: null },
    note: e.note, hasReceipt: !!e.receiptKey, receiptName: e.receiptName, receiptUrl: e.receiptKey ? `/finance/entries/${e.id}/receipt` : null,
    createdBy: e.creator ? { id: e.creator.id, name: e.creator.name, username: e.creator.username, role: e.creator.role } : null,
    decidedBy: e.decider ? { id: e.decider.id, name: e.decider.name } : null, decidedAt: e.decidedAt, decisionNote: e.decisionNote, createdAt: e.createdAt,
  });
}
