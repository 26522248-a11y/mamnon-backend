import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  MinLength, ValidateNested,
} from 'class-validator';
import { DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { overdueCutoff, todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { vndInWords } from '../common/money';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Attendance, Child, CreditTransaction, FeeItem, FeeScope, FeeType, Invoice, InvoiceAudit, InvoiceLine, LineKind, MealRefund, Payment,
} from '../database/entities';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_VND = 1_000_000_000;
export const DUE_DAY = 10;
const prevPeriod = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const lastDay = (p: string) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const signed = (kind: LineKind, n: number) => (kind === 'charge' ? n : -n);

export class FeeItemQuery {
  @ApiPropertyOptional({ enum: ['school', 'class', 'child'] }) @IsOptional() @IsIn(['school', 'class', 'child']) scope?: FeeScope;
  @ApiPropertyOptional({ enum: ['monthly', 'one_time', 'discount'] }) @IsOptional() @IsIn(['monthly', 'one_time', 'discount']) type?: FeeType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false', 'all'], default: 'true' }) @IsOptional() @IsIn(['true', 'false', 'all']) active?: string;
}
export class CreateFeeItemDto {
  @ApiProperty({ example: 'Học phí' }) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiProperty({ example: 1500000, description: 'VND, luôn ≥ 0 (giảm trừ dùng type=discount)' }) @IsInt() @Min(0) @Max(MAX_VND) amount!: number;
  @ApiProperty({ enum: ['monthly', 'one_time', 'discount'], description: 'discount: giảm trừ hằng tháng, bắt buộc reason' })
  @IsIn(['monthly', 'one_time', 'discount']) type!: FeeType;
  @ApiProperty({ enum: ['school', 'class', 'child'], description: 'school: mọi trẻ; class: cần classId; child: cần childId' })
  @IsIn(['school', 'class', 'child']) scope!: FeeScope;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ example: 'Anh chị em ruột cùng học' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional({ example: 40000, description: 'Chỉ cho khoản tiền ăn: hoàn mỗi ngày nghỉ có báo trước' })
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) mealRefundPerDay?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateFeeItemDto extends PartialType(CreateFeeItemDto) {}

export class GenerateInvoicesDto {
  @ApiProperty({ example: '2026-10' }) @Matches(PERIOD) period!: string;
  @ApiPropertyOptional({ description: 'Chỉ lập cho 1 lớp' }) @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ example: '2026-10-10', description: 'Mặc định ngày 10 của tháng' }) @IsOptional() @IsDateString() dueDate?: string;
}
class InvoiceLineDto {
  @ApiPropertyOptional({ description: 'Lấy tên/giá/loại từ khoản thu' }) @IsOptional() @IsUUID() feeItemId?: string;
  @ApiPropertyOptional({ enum: ['charge', 'discount', 'refund'], default: 'charge' }) @IsOptional() @IsIn(['charge', 'discount', 'refund']) kind?: LineKind;
  @ApiPropertyOptional({ example: 'Đồng phục' }) @IsOptional() @IsString() @MinLength(1) @MaxLength(200) description?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
  @ApiPropertyOptional({ example: 250000, description: '≥ 0; dấu do kind quyết định' }) @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) unitPrice?: number;
  @ApiPropertyOptional({ description: 'Bắt buộc với discount/refund' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() childId!: string;
  @ApiProperty({ example: '2026-10' }) @Matches(PERIOD) period!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ default: true, description: 'Tự trừ số dư trả trước/thừa' }) @IsOptional() @IsBoolean() applyCredit?: boolean;
  @ApiProperty({ type: [InvoiceLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines!: InvoiceLineDto[];
}
export class UpdateLineDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(200) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_VND) unitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class InvoiceQuery {
  @ApiPropertyOptional({ example: '2026-10' }) @IsOptional() @Matches(PERIOD) period?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ enum: ['unpaid', 'partial', 'paid', 'void', 'outstanding', 'overdue'] })
  @IsOptional() @IsIn(['unpaid', 'partial', 'paid', 'void', 'outstanding', 'overdue']) status?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(300) limit?: number;
}
export class VoidDto { @ApiProperty({ example: 'Lập nhầm' }) @IsString() @MinLength(1) @MaxLength(500) reason!: string; }
export class PaymentDto {
  @ApiProperty({ example: 1500000, description: 'Phần vượt số còn nợ được cộng vào số dư (credit) của trẻ' }) @IsInt() @Min(1) @Max(MAX_VND) amount!: number;
  @ApiProperty({ enum: ['cash', 'transfer'] }) @IsIn(['cash', 'transfer']) method!: 'cash' | 'transfer';
  @ApiPropertyOptional({ description: 'ISO 8601, mặc định bây giờ' }) @IsOptional() @IsISO8601() paidAt?: string;
  @ApiPropertyOptional({ example: 'Nguyễn Văn Hùng' }) @IsOptional() @IsString() @MaxLength(120) payerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class DebtQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ description: 'Chỉ tính hoá đơn đến kỳ này (YYYY-MM)' }) @IsOptional() @Matches(PERIOD) upToPeriod?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Chỉ trẻ có hoá đơn quá hạn (sau ngày 10)' }) @IsOptional() @IsIn(['true', 'false']) overdueOnly?: string;
}

const statusOf = (total: number, paid: number): Invoice['status'] => (total === 0 || paid >= total ? 'paid' : paid <= 0 ? 'unpaid' : 'partial');
const lineView = (l: InvoiceLine) => ({
  id: l.id, feeItemId: l.feeItemId, kind: l.kind, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, reason: l.reason,
});
const paymentView = (p: Payment) => ({
  id: p.id, receiptNo: p.receiptNo, invoiceId: p.invoiceId, childId: p.childId, amount: p.amount, creditAmount: p.creditAmount,
  method: p.method, paidAt: p.paidAt, payerName: p.payerName, note: p.note, receivedBy: p.receivedBy, receivedByName: p.receiver?.name ?? null,
});
/** Overdue from 00:01 Vietnam time on the day after the due date (PM rule). */
const isOverdue = (i: Invoice) => i.status !== 'void' && i.status !== 'paid' && i.dueDate < overdueCutoff();
const invoiceView = (i: Invoice, detail = false) => ({
  id: i.id, invoiceNo: i.invoiceNo, childId: i.childId, childName: i.child?.fullName, classId: i.classId, className: i.classRoom?.name ?? null,
  period: i.period, issueDate: i.issueDate, dueDate: i.dueDate, totalAmount: i.totalAmount, paidAmount: i.paidAmount,
  balance: i.status === 'void' ? 0 : i.totalAmount - i.paidAmount, status: i.status, note: i.note, overdue: isOverdue(i),
  ...(detail ? {
    lines: (i.lines ?? []).sort((a, b) => (a.kind === 'charge' ? 0 : 1) - (b.kind === 'charge' ? 0 : 1)).map(lineView),
    payments: (i.payments ?? []).map(paymentView),
  } : {}),
});

type DraftLine = Pick<InvoiceLine, 'feeItemId' | 'kind' | 'description' | 'quantity' | 'unitPrice' | 'amount' | 'reason'>;

/**
 * Fees & debts. Admin + accountant manage everything; parent reads invoices/receipts/balance/credit of own children only;
 * teacher has no access (403).
 */
@ApiTags('fees') @ApiBearerAuth()
@Controller()
export class FeesController {
  constructor(
    @InjectRepository(FeeItem) private items: Repository<FeeItem>,
    @InjectRepository(Invoice) private invoices: Repository<Invoice>,
    @InjectRepository(Payment) private payments: Repository<Payment>,
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(CreditTransaction) private credits: Repository<CreditTransaction>,
    private access: AccessService, private ds: DataSource, private notify: NotificationsService,
  ) {}

  private assertFinanceChild(u: AuthUser, childId: string) {
    if (u.role === 'admin' || u.role === 'accountant') return;
    if (u.role === 'parent' && u.childIds.includes(childId)) return;
    throw Forbidden('Không có quyền xem học phí của trẻ này');
  }
  private dueDefault(period: string) { return `${period}-${String(DUE_DAY).padStart(2, '0')}`; }

  /** Locks the child row so credit balance reads/writes are serialized. */
  private async creditBalance(m: EntityManager, childId: string, lock = true) {
    if (lock) await m.query('SELECT id FROM children WHERE id = $1 FOR UPDATE', [childId]);
    const [{ s }] = await m.query('SELECT COALESCE(SUM(amount), 0)::int AS s FROM credit_transactions WHERE child_id = $1', [childId]);
    return Number(s);
  }

  // ───── fee items ─────
  @Get('fee-items') @Roles('admin', 'accountant')
  async listItems(@Query() q: FeeItemQuery) {
    const where: any = {};
    for (const k of ['scope', 'type', 'classId', 'childId'] as const) if (q[k]) where[k] = q[k];
    if ((q.active ?? 'true') !== 'all') where.isActive = (q.active ?? 'true') === 'true';
    return this.items.find({ where, order: { type: 'ASC', scope: 'ASC', name: 'ASC' } });
  }

  private async validateItem(dto: Partial<CreateFeeItemDto>, base?: FeeItem) {
    const scope = dto.scope ?? base?.scope;
    const type = dto.type ?? base?.type;
    const classId = dto.classId !== undefined ? dto.classId : base?.classId;
    const childId = dto.childId !== undefined ? dto.childId : base?.childId;
    const reason = dto.reason !== undefined ? dto.reason : base?.reason;
    if (scope === 'school' && (classId || childId)) throw BadRequest('Khoản thu toàn trường không gắn lớp/trẻ', 'INVALID_SCOPE');
    if (scope === 'class') {
      if (!classId || childId) throw BadRequest('Khoản thu theo lớp cần classId (không có childId)', 'INVALID_SCOPE');
      await this.access.getClassOr404(classId);
    }
    if (scope === 'child') {
      if (!childId || classId) throw BadRequest('Khoản thu riêng cần childId (không có classId)', 'INVALID_SCOPE');
      await this.access.getChildOr404(childId);
    }
    if (type === 'discount' && !reason?.trim()) throw BadRequest('Khoản giảm trừ bắt buộc có lý do (reason)', 'REASON_REQUIRED');
    if (type !== 'monthly' && (dto.mealRefundPerDay ?? base?.mealRefundPerDay)) throw BadRequest('mealRefundPerDay chỉ dùng cho khoản thu hằng tháng', 'INVALID_REFUND_RATE');
    return { scope, classId: classId ?? null, childId: childId ?? null };
  }

  @Post('fee-items') @Roles('admin', 'accountant')
  async createItem(@Body() dto: CreateFeeItemDto) {
    const s = await this.validateItem(dto);
    return this.items.save(this.items.create({ ...dto, ...s }));
  }

  @Patch('fee-items/:id') @Roles('admin', 'accountant')
  async updateItem(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFeeItemDto) {
    const it = await this.items.findOne({ where: { id } });
    if (!it) throw NotFound('Không tìm thấy khoản thu');
    const s = await this.validateItem(dto, it);
    return this.items.save({ ...it, ...dto, ...s }); // existing invoices keep their own line prices
  }

  /** Deletes if never invoiced, otherwise deactivates (keeps invoice history intact). */
  @Delete('fee-items/:id') @Roles('admin', 'accountant')
  async removeItem(@Param('id', ParseUUIDPipe) id: string) {
    const it = await this.items.findOne({ where: { id } });
    if (!it) throw NotFound('Không tìm thấy khoản thu');
    const used = await this.ds.getRepository(InvoiceLine).count({ where: { feeItemId: id } });
    if (used) { await this.items.update(id, { isActive: false }); return { id, deleted: false, deactivated: true }; }
    await this.items.delete(id);
    return { id, deleted: true, deactivated: false };
  }

  // ───── invoices ─────
  private async nextNo(m: EntityManager, seq: 'invoice_no_seq' | 'receipt_no_seq', prefix: string, period: string) {
    const [{ n }] = await m.query(`SELECT nextval('${seq}') AS n`);
    return `${prefix}${period.replace('-', '')}-${String(n).padStart(5, '0')}`;
  }

  /** Caps deductions so the running total never goes below 0. */
  private capDeductions(lines: DraftLine[]) {
    let running = lines.filter((l) => l.kind === 'charge').reduce((s, l) => s + l.amount, 0);
    for (const l of lines.filter((x) => x.kind !== 'charge')) {
      const want = l.quantity * l.unitPrice;
      if (want > running) { l.description += ' (giới hạn bằng số phải thu)'; l.quantity = 1; l.unitPrice = running; }
      l.amount = -l.quantity * l.unitPrice;
      running -= l.quantity * l.unitPrice;
    }
    return lines.filter((l) => l.kind === 'charge' || l.unitPrice > 0);
  }

  /** Inserts invoice (+ applies available credit as a 'credit' line) inside the given transaction. */
  private async insertInvoice(m: EntityManager, u: AuthUser, child: Child, period: string, dueDate: string, lines: DraftLine[],
    opts: { note?: string | null; applyCredit?: boolean } = {}) {
    let total = lines.reduce((s, l) => s + l.amount, 0);
    if (total < 0) throw BadRequest('Tổng hoá đơn không được âm', 'NEGATIVE_TOTAL');
    let applied = 0;
    if (opts.applyCredit !== false && total > 0) {
      const bal = await this.creditBalance(m, child.id);
      applied = Math.min(bal, total);
      if (applied > 0) {
        lines.push({ feeItemId: null, kind: 'credit', description: 'Trừ số dư trả trước / trả thừa', quantity: 1, unitPrice: applied, amount: -applied, reason: null });
        total -= applied;
      }
    }
    const inv = await m.save(Invoice, m.create(Invoice, {
      invoiceNo: await this.nextNo(m, 'invoice_no_seq', 'HD', period), childId: child.id, classId: child.classId, period,
      issueDate: todayStr(), dueDate, totalAmount: total, paidAmount: 0, status: statusOf(total, 0), note: opts.note ?? null,
      createdBy: u.id, lines: lines as InvoiceLine[],
    }));
    if (applied > 0) await m.save(CreditTransaction, m.create(CreditTransaction, {
      childId: child.id, amount: -applied, type: 'applied', invoiceId: inv.id, note: `Trừ vào hoá đơn ${inv.invoiceNo}`, createdBy: u.id }));
    return inv;
  }

  /**
   * Meal refund: every absence notified in advance before this period (look-back 3 months) that has not been refunded yet.
   * Tracked per day in meal_refunds, so re-generating / catching up never refunds a day twice.
   * Clawback: refunded days whose attendance was later corrected (no longer notified absence) are charged back once.
   */
  private async mealRefundDrafts(m: EntityManager, child: Child, period: string, applicable: FeeItem[]) {
    const out: { line: DraftLine; attendanceIds?: string[]; amountPerDay?: number; reverseIds?: string[] }[] = [];
    const meal = applicable.find((f) => f.type === 'monthly' && (f.mealRefundPerDay ?? 0) > 0);
    const fmt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    if (meal) {
      const from = `${prevPeriod(prevPeriod(prevPeriod(period)))}-01`;
      const days: { id: string; date: string }[] = await m.query(`
        SELECT a.id, to_char(a.date, 'YYYY-MM-DD') AS date FROM attendance a
        WHERE a.child_id = $1 AND a.status = 'absent' AND a.notified_in_advance AND a.date >= $2 AND a.date < $3
          AND NOT EXISTS (SELECT 1 FROM meal_refunds r WHERE r.attendance_id = a.id AND r.reversed_by_line_id IS NULL)
        ORDER BY a.date`, [child.id, from, `${period}-01`]);
      if (days.length) {
        const rate = meal.mealRefundPerDay!;
        out.push({ line: { feeItemId: meal.id, kind: 'refund', description: `Hoàn tiền ăn ${days.length} ngày nghỉ có báo trước (${days.map((d) => fmt(d.date)).join(', ')})`,
          quantity: days.length, unitPrice: rate, amount: -days.length * rate, reason: 'Nghỉ có báo trước' }, attendanceIds: days.map((d) => d.id), amountPerDay: rate });
      }
    }
    const stale: { id: string; amount: number; date: string }[] = await m.query(`
      SELECT r.id, r.amount, to_char(a.date, 'YYYY-MM-DD') AS date FROM meal_refunds r JOIN attendance a ON a.id = r.attendance_id
      JOIN invoice_lines l ON l.id = r.invoice_line_id JOIN invoices i ON i.id = l.invoice_id
      WHERE r.child_id = $1 AND r.reversed_by_line_id IS NULL AND i.status <> 'void' AND NOT (a.status = 'absent' AND a.notified_in_advance)
      ORDER BY a.date`, [child.id]);
    if (stale.length) {
      const total = stale.reduce((sum, r) => sum + r.amount, 0);
      out.push({ line: { feeItemId: meal?.id ?? null, kind: 'charge', description: `Thu lại tiền ăn đã hoàn ${stale.length} ngày (điểm danh đã sửa: ${stale.map((r) => fmt(r.date)).join(', ')})`,
        quantity: 1, unitPrice: total, amount: total, reason: 'Điểm danh được sửa sau khi đã hoàn tiền' }, reverseIds: stale.map((r) => r.id) });
    }
    return out;
  }

  /** After the invoice is saved: link refunded days / clawbacks to the persisted line ids. */
  private async recordRefunds(m: EntityManager, child: Child, inv: Invoice, drafts: Awaited<ReturnType<FeesController['mealRefundDrafts']>>) {
    for (const d of drafts) {
      const line = inv.lines.find((l) => (d.attendanceIds ? l.kind === 'refund' : l.kind === 'charge' && l.description.startsWith('Thu lại tiền ăn')));
      if (!line) continue; // dropped by capDeductions
      if (d.attendanceIds) await m.save(MealRefund, d.attendanceIds.map((attendanceId) => m.create(MealRefund, {
        attendanceId, childId: child.id, invoiceLineId: line.id, amount: d.amountPerDay!, reversedByLineId: null })));
      if (d.reverseIds?.length) await m.update(MealRefund, { id: In(d.reverseIds) }, { reversedByLineId: line.id });
    }
  }

  /**
   * Monthly invoices for all active children (or one class): monthly charges + discounts (school/class/child),
   * meal refund for last month's notified absences, then available credit. Skips children already invoiced.
   */
  @Post('invoices/generate') @Roles('admin', 'accountant')
  async generate(@CurrentUser() u: AuthUser, @Body() dto: GenerateInvoicesDto) {
    if (dto.classId) await this.access.getClassOr404(dto.classId);
    const kids = await this.children.find({ where: { status: 'active', ...(dto.classId ? { classId: dto.classId } : {}) }, order: { fullName: 'ASC' } });
    const fees = await this.items.find({ where: { isActive: true, type: In(['monthly', 'discount']) } });
    const existing = new Set((await this.invoices.find({ where: { period: dto.period, status: Not('void'), childId: In(kids.length ? kids.map((k) => k.id) : ['00000000-0000-0000-0000-000000000000']) } })).map((i) => i.childId));
    const created: Invoice[] = [];
    await this.ds.transaction(async (m) => {
      for (const k of kids) {
        if (existing.has(k.id)) continue;
        const applicable = fees.filter((f) => f.scope === 'school' || (f.scope === 'class' && f.classId === k.classId) || (f.scope === 'child' && f.childId === k.id));
        const charges = applicable.filter((f) => f.type === 'monthly');
        if (!charges.length) continue;
        const lines: DraftLine[] = [
          ...charges.map((f) => ({ feeItemId: f.id, kind: 'charge' as const, description: f.name, quantity: 1, unitPrice: f.amount, amount: f.amount, reason: null })),
          ...applicable.filter((f) => f.type === 'discount').map((f) => ({ feeItemId: f.id, kind: 'discount' as const, description: f.name, quantity: 1, unitPrice: f.amount, amount: -f.amount, reason: f.reason })),
        ];
        const refunds = await this.mealRefundDrafts(m, k, dto.period, applicable);
        lines.push(...refunds.map((r) => r.line));
        const inv = await this.insertInvoice(m, u, k, dto.period, dto.dueDate ?? this.dueDefault(dto.period), this.capDeductions(lines));
        await this.recordRefunds(m, k, inv, refunds);
        created.push(inv);
      }
    });
    await this.notifyInvoices(created);
    return {
      period: dto.period, created: created.length, skippedExisting: kids.filter((k) => existing.has(k.id)).length,
      totalAmount: created.reduce((s, i) => s + i.totalAmount, 0), invoiceIds: created.map((i) => i.id),
    };
  }

  private async notifyInvoices(list: Invoice[]) {
    for (const i of list) {
      await this.notify.toParentsOfChild(i.childId, {
        type: 'invoice', title: `Hoá đơn học phí tháng ${i.period.slice(5)}/${i.period.slice(0, 4)}`,
        body: `Số tiền: ${i.totalAmount.toLocaleString('vi-VN')}đ, hạn nộp ${i.dueDate.split('-').reverse().join('/')}.`,
        data: { invoiceId: i.id, childId: i.childId, period: i.period, totalAmount: i.totalAmount },
      });
    }
  }

  private async buildLines(dto: InvoiceLineDto[]): Promise<DraftLine[]> {
    const feeIds = dto.map((l) => l.feeItemId).filter(Boolean) as string[];
    const fees = feeIds.length ? await this.items.find({ where: { id: In(feeIds) } }) : [];
    return dto.map((l) => {
      const f = l.feeItemId ? fees.find((x) => x.id === l.feeItemId) : undefined;
      if (l.feeItemId && !f) throw BadRequest('Khoản thu không tồn tại', 'INVALID_FEE_ITEM');
      const kind: LineKind = l.kind ?? (f?.type === 'discount' ? 'discount' : 'charge');
      const description = l.description ?? f?.name, unitPrice = l.unitPrice ?? f?.amount, quantity = l.quantity ?? 1;
      const reason = l.reason ?? (f?.type === 'discount' ? f.reason : null) ?? null;
      if (!description || unitPrice === undefined) throw BadRequest('Dòng hoá đơn cần feeItemId hoặc description + unitPrice', 'INVALID_LINE');
      if (kind !== 'charge' && !reason?.trim()) throw BadRequest('Dòng giảm trừ / hoàn tiền bắt buộc có lý do (reason)', 'REASON_REQUIRED');
      return { feeItemId: f?.id ?? null, kind, description, quantity, unitPrice, amount: signed(kind, unitPrice * quantity), reason };
    });
  }

  /** Manual invoice (one-time fees, adjustments). One live invoice per child per period. */
  @Post('invoices') @Roles('admin', 'accountant')
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateInvoiceDto) {
    const child = await this.access.getChildOr404(dto.childId);
    const lines = await this.buildLines(dto.lines);
    if (await this.invoices.exist({ where: { childId: child.id, period: dto.period, status: Not('void') } }))
      throw new AppError(409, 'INVOICE_EXISTS', 'Trẻ đã có hoá đơn kỳ này; huỷ hoá đơn cũ hoặc chọn kỳ khác');
    const inv = await this.ds.transaction((m) => this.insertInvoice(m, u, child, dto.period, dto.dueDate ?? this.dueDefault(dto.period), lines,
      { note: dto.note, applyCredit: dto.applyCredit }));
    await this.notifyInvoices([inv]);
    return this.getInvoice(u, inv.id);
  }

  @Get('invoices') @Roles('admin', 'accountant', 'parent')
  async list(@CurrentUser() u: AuthUser, @Query() q: InvoiceQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const qb = this.invoices.createQueryBuilder('i').leftJoinAndSelect('i.child', 'c').leftJoinAndSelect('i.classRoom', 'cl');
    if (u.role === 'parent') qb.andWhere('i.child_id = ANY(:kids)', { kids: u.childIds });
    if (q.period) qb.andWhere('i.period = :p', { p: q.period });
    if (q.classId) qb.andWhere('i.class_id = :cl', { cl: q.classId });
    if (q.childId) qb.andWhere('i.child_id = :ch', { ch: q.childId });
    if (q.status === 'outstanding') qb.andWhere("i.status IN ('unpaid','partial')");
    else if (q.status === 'overdue') qb.andWhere("i.status IN ('unpaid','partial')").andWhere('i.due_date < :cut', { cut: overdueCutoff() });
    else if (q.status) qb.andWhere('i.status = :st', { st: q.status });
    qb.orderBy('i.period', 'DESC').addOrderBy('c.fullName', 'ASC').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((i) => invoiceView(i)), page, limit, total };
  }

  @Get('invoices/:id') @Roles('admin', 'accountant', 'parent')
  async getInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const i = await this.invoices.findOne({
      where: { id }, relations: { child: true, classRoom: true, lines: true, payments: { receiver: true } },
      order: { payments: { paidAt: 'ASC' } } as any,
    });
    if (!i) throw NotFound('Không tìm thấy hoá đơn');
    this.assertFinanceChild(u, i.childId);
    return invoiceView(i, true);
  }

  private audit(m: EntityManager, u: AuthUser, invoiceId: string, action: InvoiceAudit['action'], lineId: string | null, oldValue: any, newValue: any) {
    return m.save(InvoiceAudit, m.create(InvoiceAudit, { invoiceId, action, lineId, oldValue, newValue, changedBy: u.id }));
  }

  @Get('invoices/:id/history') @Roles('admin', 'accountant')
  async history(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.invoices.exist({ where: { id } }))) throw NotFound('Không tìm thấy hoá đơn');
    const rows = await this.ds.getRepository(InvoiceAudit).find({ where: { invoiceId: id }, relations: { changer: true }, order: { changedAt: 'ASC' } });
    return rows.map((r) => ({ id: r.id, action: r.action, lineId: r.lineId, old: r.oldValue, new: r.newValue,
      changedBy: r.changedBy, changedByName: r.changer?.name ?? null, changedAt: r.changedAt }));
  }

  /** Recompute totals after a line change; total must stay ≥ paid amount. */
  private async editLines(u: AuthUser, id: string, fn: (m: EntityManager, inv: Invoice) => Promise<void>) {
    await this.ds.transaction(async (m) => {
      const inv = await m.findOne(Invoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!inv) throw NotFound('Không tìm thấy hoá đơn');
      if (inv.status === 'void') throw BadRequest('Hoá đơn đã huỷ', 'INVOICE_VOID');
      await fn(m, inv);
      const [{ s }] = await m.query('SELECT COALESCE(SUM(amount),0)::int AS s FROM invoice_lines WHERE invoice_id = $1', [id]);
      const total = Number(s);
      if (total < 0) throw BadRequest('Tổng hoá đơn không được âm', 'NEGATIVE_TOTAL');
      if (total < inv.paidAmount) throw new AppError(409, 'TOTAL_BELOW_PAID', 'Tổng mới nhỏ hơn số đã thu; ghi nhận phần chênh vào số dư thay vì sửa dòng');
      await m.update(Invoice, id, { totalAmount: total, status: statusOf(total, inv.paidAmount) });
    });
    return this.getInvoice(u, id);
  }

  @Post('invoices/:id/lines') @Roles('admin', 'accountant')
  async addLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceLineDto) {
    const [line] = await this.buildLines([dto]);
    return this.editLines(u, id, async (m) => {
      const l = await m.save(InvoiceLine, m.create(InvoiceLine, { ...line, invoiceId: id }));
      await this.audit(m, u, id, 'line_added', l.id, null, lineView(l));
    });
  }

  /** Accountant can adjust any line incl. the auto meal refund (not credit lines: void + re-issue instead). */
  @Patch('invoices/:id/lines/:lineId') @Roles('admin', 'accountant')
  async updateLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: UpdateLineDto) {
    return this.editLines(u, id, async (m) => {
      const l = await m.findOne(InvoiceLine, { where: { id: lineId, invoiceId: id } });
      if (!l) throw NotFound('Không tìm thấy dòng hoá đơn');
      if (l.kind === 'credit') throw new AppError(409, 'CREDIT_LINE_LOCKED', 'Không sửa dòng trừ số dư; huỷ và lập lại hoá đơn');
      const before = lineView(l);
      Object.assign(l, dto);
      if (l.kind !== 'charge' && !l.reason?.trim()) throw BadRequest('Dòng giảm trừ / hoàn tiền bắt buộc có lý do', 'REASON_REQUIRED');
      l.amount = signed(l.kind, l.quantity * l.unitPrice);
      await m.save(InvoiceLine, l);
      await this.audit(m, u, id, 'line_updated', l.id, before, lineView(l));
    });
  }

  @Delete('invoices/:id/lines/:lineId') @Roles('admin', 'accountant')
  async deleteLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.editLines(u, id, async (m) => {
      const l = await m.findOne(InvoiceLine, { where: { id: lineId, invoiceId: id } });
      if (!l) throw NotFound('Không tìm thấy dòng hoá đơn');
      if (l.kind === 'credit') throw new AppError(409, 'CREDIT_LINE_LOCKED', 'Không xoá dòng trừ số dư; huỷ và lập lại hoá đơn');
      if (await m.exists(MealRefund, { where: [{ invoiceLineId: lineId }, { reversedByLineId: lineId }] }))
        throw new AppError(409, 'REFUND_LINE_USE_PATCH', 'Dòng hoàn/thu lại tiền ăn: dùng PATCH (vd. unitPrice=0) thay vì xoá, để không bị hoàn lại lần nữa');
      await m.delete(InvoiceLine, lineId);
      await this.audit(m, u, id, 'line_deleted', lineId, lineView(l), null);
    });
  }

  @Post('invoices/:id/void') @Roles('admin', 'accountant') @HttpCode(200)
  async voidInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidDto) {
    await this.ds.transaction(async (m) => {
      const i = await m.findOne(Invoice, { where: { id }, relations: { lines: true }, lock: { mode: 'pessimistic_write', tables: ['invoices'] } });
      if (!i) throw NotFound('Không tìm thấy hoá đơn');
      if (i.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'Hoá đơn đã huỷ');
      await m.update(Invoice, id, { status: 'void', note: `[Huỷ] ${dto.reason}${i.note ? ' | ' + i.note : ''}` });
      await this.audit(m, u, id, 'voided', null, { status: i.status, totalAmount: i.totalAmount, paidAmount: i.paidAmount }, { status: 'void', reason: dto.reason });
      await this.creditBalance(m, i.childId); // lock child's credit ledger
      const usedCredit = i.lines.filter((l) => l.kind === 'credit').reduce((s, l) => s + l.unitPrice * l.quantity, 0);
      if (usedCredit > 0) await m.save(CreditTransaction, m.create(CreditTransaction, { childId: i.childId, amount: usedCredit, type: 'restored', invoiceId: id,
        note: `Hoàn lại số dư do huỷ hoá đơn ${i.invoiceNo}`, createdBy: u.id }));
      // money already paid on a voided invoice is never lost: it moves to the child's credit balance (PM/QA FEE-P06)
      if (i.paidAmount > 0) await m.save(CreditTransaction, m.create(CreditTransaction, { childId: i.childId, amount: i.paidAmount, type: 'void_refund', invoiceId: id,
        note: `Tiền đã nộp cho hoá đơn ${i.invoiceNo} (đã huỷ) chuyển thành số dư`, createdBy: u.id }));
      // release refunded meal days / clawbacks so the next invoice handles them again
      const lineIds = i.lines.map((l) => l.id);
      if (lineIds.length) {
        await m.delete(MealRefund, { invoiceLineId: In(lineIds) });
        await m.update(MealRefund, { reversedByLineId: In(lineIds) }, { reversedByLineId: null });
      }
    });
    // partial unique index (status <> 'void') frees the (child, period) slot so a corrected invoice can be issued
    return this.getInvoice(u, id);
  }

  /** Pay an invoice. Any amount above the outstanding balance becomes credit for the child (applied next month). */
  @Post('invoices/:id/payments') @Roles('admin', 'accountant')
  async pay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) {
    const paymentId = await this.ds.transaction(async (m) => {
      const i = await m.findOne(Invoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!i) throw NotFound('Không tìm thấy hoá đơn');
      if (i.status === 'void') throw BadRequest('Hoá đơn đã huỷ', 'INVOICE_VOID');
      const balance = i.totalAmount - i.paidAmount;
      if (balance <= 0) throw new AppError(409, 'ALREADY_PAID', 'Hoá đơn đã thanh toán đủ; dùng POST /children/:id/prepayments để trả trước');
      const applied = Math.min(dto.amount, balance), excess = dto.amount - applied;
      const p = await m.save(Payment, m.create(Payment, {
        receiptNo: await this.nextNo(m, 'receipt_no_seq', 'PT', i.period), invoiceId: id, childId: i.childId, amount: dto.amount, creditAmount: excess,
        method: dto.method, paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(), payerName: dto.payerName ?? null, note: dto.note ?? null, receivedBy: u.id,
      }));
      const paid = i.paidAmount + applied;
      await m.update(Invoice, id, { paidAmount: paid, status: statusOf(i.totalAmount, paid) });
      if (excess > 0) {
        await this.creditBalance(m, i.childId);
        await m.save(CreditTransaction, m.create(CreditTransaction, { childId: i.childId, amount: excess, type: 'overpayment', paymentId: p.id, invoiceId: id,
          note: `Trả thừa ở phiếu ${p.receiptNo}`, createdBy: u.id }));
      }
      return p.id;
    });
    return this.receipt(u, paymentId);
  }

  /** Prepayment without an invoice: goes fully to the child's credit balance and is applied to the next invoice. */
  @Post('children/:id/prepayments') @Roles('admin', 'accountant')
  async prepay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) {
    await this.access.getChildOr404(id);
    const paymentId = await this.ds.transaction(async (m) => {
      await this.creditBalance(m, id);
      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      const p = await m.save(Payment, m.create(Payment, {
        receiptNo: await this.nextNo(m, 'receipt_no_seq', 'PT', todayStr().slice(0, 7)), invoiceId: null, childId: id, amount: dto.amount,
        creditAmount: dto.amount, method: dto.method, paidAt, payerName: dto.payerName ?? null, note: dto.note ?? null, receivedBy: u.id,
      }));
      await m.save(CreditTransaction, m.create(CreditTransaction, { childId: id, amount: dto.amount, type: 'prepayment', paymentId: p.id,
        note: `Trả trước ở phiếu ${p.receiptNo}`, createdBy: u.id }));
      return p.id;
    });
    return this.receipt(u, paymentId);
  }

  @Get('children/:id/credits') @Roles('admin', 'accountant', 'parent')
  async creditsOf(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.getChildOr404(id);
    this.assertFinanceChild(u, id);
    const tx = await this.credits.find({ where: { childId: id }, order: { createdAt: 'DESC' } });
    return { childId: id, creditBalance: tx.reduce((s, t) => s + t.amount, 0),
      transactions: tx.map((t) => ({ id: t.id, amount: t.amount, type: t.type, paymentId: t.paymentId, invoiceId: t.invoiceId, note: t.note, createdAt: t.createdAt })) };
  }

  /** Data for printing a receipt (phiếu thu). */
  @Get('payments/:id/receipt') @Roles('admin', 'accountant', 'parent')
  async receipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.payments.findOne({ where: { id }, relations: { receiver: true, child: { classRoom: true }, invoice: { classRoom: true, lines: true } } });
    if (!p) throw NotFound('Không tìm thấy phiếu thu');
    this.assertFinanceChild(u, p.childId);
    const i = p.invoice;
    const creditBalance = Number((await this.ds.query('SELECT COALESCE(SUM(amount),0)::int AS s FROM credit_transactions WHERE child_id = $1', [p.childId]))[0].s);
    return {
      school: { name: process.env.SCHOOL_NAME || 'Trường Mầm non', address: process.env.SCHOOL_ADDRESS || null, phone: process.env.SCHOOL_PHONE || null },
      receiptNo: p.receiptNo, paymentId: p.id, paidAt: p.paidAt, method: p.method, payerName: p.payerName,
      amount: p.amount, amountInWords: vndInWords(p.amount), appliedToInvoice: p.amount - p.creditAmount, creditAdded: p.creditAmount,
      currentCreditBalance: creditBalance, note: p.note, receivedByName: p.receiver?.name ?? null, kind: i ? 'invoice' : 'prepayment',
      child: { id: p.childId, fullName: p.child.fullName, className: i?.classRoom?.name ?? p.child.classRoom?.name ?? null },
      invoice: i ? { id: i.id, invoiceNo: i.invoiceNo, period: i.period, totalAmount: i.totalAmount, paidAmount: i.paidAmount,
        balanceAfter: i.totalAmount - i.paidAmount, status: i.status, lines: i.lines.map(lineView) } : null,
    };
  }

  // ───── debts ─────
  @Get('children/:id/balance') @Roles('admin', 'accountant', 'parent')
  async balance(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const child = await this.access.getChildOr404(id);
    this.assertFinanceChild(u, id);
    const rows = await this.invoices.find({ where: { childId: id }, order: { period: 'ASC' } });
    const live = rows.filter((i) => i.status !== 'void');
    const totalInvoiced = live.reduce((s, i) => s + i.totalAmount, 0), totalPaid = live.reduce((s, i) => s + i.paidAmount, 0);
    const creditBalance = Number((await this.ds.query('SELECT COALESCE(SUM(amount),0)::int AS s FROM credit_transactions WHERE child_id = $1', [id]))[0].s);
    const outstanding = live.filter((i) => i.paidAmount < i.totalAmount);
    return {
      childId: id, fullName: child.fullName, className: child.classRoom?.name ?? null, totalInvoiced, totalPaid,
      balance: totalInvoiced - totalPaid, creditBalance, netBalance: totalInvoiced - totalPaid - creditBalance,
      overdueAmount: outstanding.filter(isOverdue).reduce((s, i) => s + i.totalAmount - i.paidAmount, 0),
      outstanding: outstanding.map((i) => invoiceView(i)),
    };
  }

  /** Children with unpaid balances. `overdue` = has an unpaid invoice past its due date (default the 10th). */
  @Get('debts') @Roles('admin', 'accountant')
  async debts(@Query() q: DebtQuery) {
    const today = overdueCutoff(); // due_date < cutoff => overdue
    const qb = this.invoices.createQueryBuilder('i').innerJoin('i.child', 'c').leftJoin('c.classRoom', 'cl')
      .select('i.child_id', 'childId').addSelect('c.full_name', 'fullName').addSelect('c.class_id', 'classId').addSelect('cl.name', 'className')
      .addSelect('SUM(i.total_amount - i.paid_amount)::int', 'balance').addSelect('COUNT(*)::int', 'invoiceCount')
      .addSelect("to_char(MIN(i.due_date), 'YYYY-MM-DD')", 'oldestDueDate')
      .addSelect('COALESCE(SUM(i.total_amount - i.paid_amount) FILTER (WHERE i.due_date < :today), 0)::int', 'overdueAmount')
      .addSelect('COUNT(*) FILTER (WHERE i.due_date < :today)::int', 'overdueInvoiceCount')
      .addSelect('(SELECT COALESCE(SUM(ct.amount),0)::int FROM credit_transactions ct WHERE ct.child_id = i.child_id)', 'creditBalance')
      .where("i.status IN ('unpaid','partial')").setParameter('today', today)
      .groupBy('i.child_id').addGroupBy('c.full_name').addGroupBy('c.class_id').addGroupBy('cl.name')
      .orderBy('"overdueAmount"', 'DESC').addOrderBy('balance', 'DESC');
    if (q.classId) qb.andWhere('c.class_id = :cl', { cl: q.classId });
    if (q.upToPeriod) qb.andWhere('i.period <= :p', { p: q.upToPeriod });
    if (q.overdueOnly === 'true') qb.having('COUNT(*) FILTER (WHERE i.due_date < :today) > 0');
    const items = (await qb.getRawMany()).map((r) => ({
      ...r, balance: Number(r.balance), invoiceCount: Number(r.invoiceCount), overdueAmount: Number(r.overdueAmount),
      overdueInvoiceCount: Number(r.overdueInvoiceCount), creditBalance: Number(r.creditBalance), overdue: Number(r.overdueInvoiceCount) > 0,
    }));
    return {
      asOf: new Date().toISOString(), overdueCutoff: today, overdueRule: 'Quá hạn từ 00:01 (giờ VN) ngày sau hạn nộp', dueDay: DUE_DAY, totalDebt: items.reduce((s, r) => s + r.balance, 0), totalOverdue: items.reduce((s, r) => s + r.overdueAmount, 0),
      childCount: items.length, overdueChildCount: items.filter((r) => r.overdue).length, items,
    };
  }
}
