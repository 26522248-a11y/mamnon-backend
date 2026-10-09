import { schoolInfo } from '../common/school';
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
import { addDays, overdueCutoff, todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { vndInWords } from '../common/money';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Attendance, Child, CreditTransaction, FeeItem, FeeScope, FeeType, Invoice, InvoiceAudit, InvoiceLine, LineKind, MealRefund, Payment,
  PickupRequest, RefundPayout,
} from '../database/entities';

/**
 * Attendance row whose meal is refunded: a parent-reported (before cutoff) absence, or any absence on a confirmed
 * EMERGENCY closure day (children not present that day; present ones eat → no refund).
 */
export const MEAL_REFUNDABLE = `a.status = 'absent' AND (a.notified_in_advance OR EXISTS (
  SELECT 1 FROM holidays h WHERE h.date = a.date AND h.kind = 'emergency' AND h.status = 'confirmed'))`;

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
export class VoidDto {
  @ApiProperty({ example: 'Lập nhầm', description: 'Bắt buộc. Nếu hoá đơn đã thu tiền, số đã thu chuyển vào số dư (credit) của trẻ.' })
  @IsString() @MaxLength(500) reason!: string;
}
export class WithdrawDto {
  @ApiProperty({ example: '2026-10-15', description: 'Ngày học cuối cùng (không được ở tương lai)' }) @IsDateString() leaveDate!: string;
  @ApiProperty({ example: 'Chuyển nhà' }) @IsString() @MaxLength(500) reason!: string;
}
export class PayoutDto {
  @ApiPropertyOptional({ example: 350000, description: 'Mặc định = toàn bộ số dư; nếu gửi phải đúng bằng số dư (số dư về 0)' }) @IsOptional() @IsInt() @Min(1) @Max(MAX_VND) amount?: number;
  @ApiProperty({ enum: ['cash', 'transfer'] }) @IsIn(['cash', 'transfer']) method!: 'cash' | 'transfer';
  @ApiProperty({ example: 'Nguyễn Văn Hùng', description: 'Người nhận tiền' }) @IsString() @MinLength(1) @MaxLength(120) recipientName!: string;
  @ApiPropertyOptional({ description: 'ISO 8601, mặc định bây giờ' }) @IsOptional() @IsISO8601() paidAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export type CapWarning = { code: 'DISCOUNT_CAPPED'; message: string; lineId?: string; description: string; kind: LineKind; requested: number; applied: number; discarded: number };
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

/** 0đ invoice because discounts/refunds cover every charge (not because prepaid credit covered it). */
export const WAIVER_NOTE = 'Miễn/giảm 100%';
const isWaived = (lines: { kind: string; amount: number }[]) =>
  lines.some((l) => l.kind === 'charge' && l.amount > 0) && lines.some((l) => l.kind === 'discount' || l.kind === 'refund')
  && lines.filter((l) => l.kind !== 'credit').reduce((s, l) => s + l.amount, 0) === 0;
const withWaiverNote = (note: string | null | undefined, waived: boolean): string | null => {
  const rest = (note ?? '').split(' | ').filter((x) => x && x !== WAIVER_NOTE).join(' | ');
  return waived ? (rest ? `${WAIVER_NOTE} | ${rest}` : WAIVER_NOTE) : rest || null;
};
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
  /** true: 0đ, miễn/giảm 100% -> status paid, no receipt exists or can be created */
  waived: i.status !== 'void' && i.totalAmount === 0 && (i.note ?? '').split(' | ').includes(WAIVER_NOTE),
  ...(detail ? {
    lines: (i.lines ?? []).sort((a, b) => (a.kind === 'charge' ? 0 : 1) - (b.kind === 'charge' ? 0 : 1)).map(lineView),
    payments: (i.payments ?? []).map(paymentView),
  } : {}),
});

type DraftLine = Pick<InvoiceLine, 'feeItemId' | 'kind' | 'description' | 'quantity' | 'unitPrice' | 'amount' | 'reason'>;
const capMsg = (requested: number, applied: number) =>
  `Giảm trừ ${requested.toLocaleString('vi-VN')}đ vượt số phải thu; chỉ áp dụng ${applied.toLocaleString('vi-VN')}đ, phần dư ${(requested - applied).toLocaleString('vi-VN')}đ bị bỏ (không chuyển thành số dư)`;
const applicableFees = (fees: FeeItem[], k: Child) =>
  fees.filter((f) => f.scope === 'school' || (f.scope === 'class' && f.classId === k.classId) || (f.scope === 'child' && f.childId === k.id));
const mealItemOf = (applicable: FeeItem[]) => applicable.find((f) => f.type === 'monthly' && (f.mealRefundPerDay ?? 0) > 0);
/**
 * Monthly charges + discounts. With `mealDays` (leave month, PM rule) the meal item is charged per day actually attended
 * (rate = mealRefundPerDay, never more than the monthly meal fee); fixed fees (tuition…) stay the full month.
 */
const monthlyLines = (applicable: FeeItem[], mealDays?: number): DraftLine[] => {
  const meal = mealItemOf(applicable);
  const out: DraftLine[] = [];
  for (const f of applicable.filter((x) => x.type === 'monthly')) {
    if (mealDays !== undefined && meal && f.id === meal.id) {
      const amt = Math.min(f.amount, mealDays * meal.mealRefundPerDay!);
      if (amt > 0) out.push({ feeItemId: f.id, kind: 'charge', description: `${f.name} (${mealDays} ngày đi học thực tế, tháng nghỉ học)`,
        quantity: amt === f.amount ? 1 : mealDays, unitPrice: amt === f.amount ? f.amount : meal.mealRefundPerDay!, amount: amt, reason: null });
    } else out.push({ feeItemId: f.id, kind: 'charge', description: f.name, quantity: 1, unitPrice: f.amount, amount: f.amount, reason: null });
  }
  for (const f of applicable.filter((x) => x.type === 'discount'))
    out.push({ feeItemId: f.id, kind: 'discount', description: f.name, quantity: 1, unitPrice: f.amount, amount: -f.amount, reason: f.reason });
  return out;
};
const leaveMonth = (c: Child) => c.leaveDate?.slice(0, 7) ?? null;
/** Active meal refund = not reversed by a later invoice line or by a withdrawal settlement. */
const MR_ACTIVE = 'r.reversed_by_line_id IS NULL AND r.reversed_by_credit_tx_id IS NULL';

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

  /**
   * PM rule (same for auto-generated and manual invoices): deductions can bring the invoice to 0đ but never below.
   * Meal refunds are applied before discounts, so it is the discount that gets capped. The excess is discarded
   * (NOT turned into credit) and reported back as a warning for the accountant.
   */
  private capDeductions(lines: DraftLine[]): { lines: DraftLine[]; warnings: CapWarning[] } {
    const warnings: CapWarning[] = [];
    let running = lines.filter((l) => l.kind === 'charge').reduce((s, l) => s + l.amount, 0);
    const order = (k: LineKind) => (k === 'refund' ? 0 : k === 'discount' ? 1 : 2);
    for (const l of lines.filter((x) => x.kind !== 'charge').sort((a, b) => order(a.kind) - order(b.kind))) {
      const want = l.quantity * l.unitPrice;
      if (want > running) {
        warnings.push({ code: 'DISCOUNT_CAPPED', message: capMsg(want, running), description: l.description, kind: l.kind, requested: want, applied: running, discarded: want - running });
        l.description += ' (giới hạn bằng số phải thu)'; l.quantity = 1; l.unitPrice = running;
      }
      l.amount = -l.quantity * l.unitPrice;
      running -= l.quantity * l.unitPrice;
    }
    return { lines: lines.filter((l) => l.kind === 'charge' || l.unitPrice > 0), warnings };
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
      issueDate: todayStr(), dueDate, totalAmount: total, paidAmount: 0, status: statusOf(total, 0), note: withWaiverNote(opts.note, total === 0 && isWaived(lines)),
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
        WHERE a.child_id = $1 AND ${MEAL_REFUNDABLE} AND a.date >= $2 AND a.date < $3
          AND NOT EXISTS (SELECT 1 FROM meal_refunds r WHERE r.attendance_id = a.id AND ${MR_ACTIVE})
        ORDER BY a.date`, [child.id, from, `${period}-01`]);
      if (days.length) {
        const rate = meal.mealRefundPerDay!;
        out.push({ line: { feeItemId: meal.id, kind: 'refund', description: `Hoàn tiền ăn ${days.length} ngày nghỉ có báo trước (${days.map((d) => fmt(d.date)).join(', ')})`,
          quantity: days.length, unitPrice: rate, amount: -days.length * rate, reason: 'Nghỉ có báo trước' }, attendanceIds: days.map((d) => d.id), amountPerDay: rate });
      }
    }
    const stale = await this.staleRefunds(m, child.id);
    if (stale.length) {
      const total = stale.reduce((sum, r) => sum + r.amount, 0);
      out.push({ line: { feeItemId: meal?.id ?? null, kind: 'charge', description: `Thu lại tiền ăn đã hoàn ${stale.length} ngày (điểm danh đã sửa: ${stale.map((r) => fmt(r.date)).join(', ')})`,
        quantity: 1, unitPrice: total, amount: total, reason: 'Điểm danh được sửa sau khi đã hoàn tiền' }, reverseIds: stale.map((r) => r.id) });
    }
    return out;
  }

  /** Refunded days (on a live invoice or via withdrawal credit) whose attendance is no longer a notified absence. */
  private staleRefunds(m: EntityManager, childId: string): Promise<{ id: string; amount: number; date: string }[]> {
    return m.query(`
      SELECT r.id, r.amount, to_char(a.date, 'YYYY-MM-DD') AS date FROM meal_refunds r JOIN attendance a ON a.id = r.attendance_id
      LEFT JOIN invoice_lines l ON l.id = r.invoice_line_id LEFT JOIN invoices i ON i.id = l.invoice_id
      WHERE r.child_id = $1 AND ${MR_ACTIVE} AND (r.invoice_line_id IS NULL OR i.status <> 'void')
        AND NOT (${MEAL_REFUNDABLE})
      ORDER BY a.date`, [childId]);
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
    const warnings: (CapWarning & { invoiceId: string; childId: string; childName: string })[] = [];
    await this.ds.transaction(async (m) => {
      for (const k of kids) {
        if (existing.has(k.id)) continue;
        const applicable = applicableFees(fees, k);
        if (!applicable.some((f) => f.type === 'monthly')) continue;
        const lines = monthlyLines(applicable);
        const refunds = await this.mealRefundDrafts(m, k, dto.period, applicable);
        lines.push(...refunds.map((r) => r.line));
        const capped = this.capDeductions(lines);
        const inv = await this.insertInvoice(m, u, k, dto.period, dto.dueDate ?? this.dueDefault(dto.period), capped.lines);
        await this.recordRefunds(m, k, inv, refunds);
        warnings.push(...capped.warnings.map((w) => ({ ...w, invoiceId: inv.id, childId: k.id, childName: k.fullName })));
        created.push(inv);
      }
    });
    await this.notifyInvoices(created);
    return {
      period: dto.period, created: created.length, skippedExisting: kids.filter((k) => existing.has(k.id)).length,
      totalAmount: created.reduce((s, i) => s + i.totalAmount, 0), invoiceIds: created.map((i) => i.id), warnings,
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
    if (child.status === 'withdrawn' && dto.period > leaveMonth(child)!)
      throw new AppError(409, 'CHILD_WITHDRAWN', `Trẻ đã nghỉ học từ ${child.leaveDate}; không lập hoá đơn cho kỳ sau tháng nghỉ`);
    const { lines, warnings } = this.capDeductions(await this.buildLines(dto.lines));
    if (await this.invoices.exist({ where: { childId: child.id, period: dto.period, status: Not('void') } }))
      throw new AppError(409, 'INVOICE_EXISTS', 'Trẻ đã có hoá đơn kỳ này; huỷ hoá đơn cũ hoặc chọn kỳ khác');
    const inv = await this.ds.transaction((m) => this.insertInvoice(m, u, child, dto.period, dto.dueDate ?? this.dueDefault(dto.period), lines,
      { note: dto.note, applyCredit: dto.applyCredit }));
    await this.notifyInvoices([inv]);
    return { ...(await this.getInvoice(u, inv.id)), warnings };
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

  /**
   * Recompute totals after a line change; total must stay ≥ paid amount.
   * If deductions push the total below 0 they are capped (discounts first, then refunds) with a warning – same rule as new invoices.
   */
  private async editLines(u: AuthUser, id: string, fn: (m: EntityManager, inv: Invoice) => Promise<string | void>) {
    const warnings: CapWarning[] = [];
    await this.ds.transaction(async (m) => {
      const inv = await m.findOne(Invoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!inv) throw NotFound('Không tìm thấy hoá đơn');
      if (inv.status === 'void') throw BadRequest('Hoá đơn đã huỷ', 'INVOICE_VOID');
      const touched = await fn(m, inv);
      const all = await m.find(InvoiceLine, { where: { invoiceId: id } });
      let total = all.reduce((s, l) => s + l.amount, 0);
      if (total < 0) {
        const order = (k: LineKind) => (k === 'discount' ? 0 : k === 'refund' ? 1 : 2);
        for (const l of all.filter((x) => x.kind === 'discount' || x.kind === 'refund').sort((a, b) => order(a.kind) - order(b.kind) || (a.id === touched ? -1 : b.id === touched ? 1 : 0))) {
          if (total >= 0) break;
          const want = l.quantity * l.unitPrice, cut = Math.min(want, -total), keep = want - cut;
          warnings.push({ code: 'DISCOUNT_CAPPED', message: capMsg(want, keep), lineId: l.id, description: l.description, kind: l.kind, requested: want, applied: keep, discarded: cut });
          const before = lineView(l);
          Object.assign(l, { quantity: 1, unitPrice: keep, amount: -keep, description: l.description.endsWith('(giới hạn bằng số phải thu)') ? l.description : `${l.description} (giới hạn bằng số phải thu)` });
          await m.save(InvoiceLine, l);
          await this.audit(m, u, id, 'line_updated', l.id, before, { ...lineView(l), capped: true });
          total += cut;
        }
      }
      if (total < 0) throw BadRequest('Tổng hoá đơn không được âm', 'NEGATIVE_TOTAL');
      if (total < inv.paidAmount) throw new AppError(409, 'TOTAL_BELOW_PAID', 'Tổng mới nhỏ hơn số đã thu; ghi nhận phần chênh vào số dư thay vì sửa dòng');
      await m.update(Invoice, id, { totalAmount: total, status: statusOf(total, inv.paidAmount), note: withWaiverNote(inv.note, total === 0 && isWaived(all)) });
    });
    return { ...(await this.getInvoice(u, id)), warnings };
  }

  @Post('invoices/:id/lines') @Roles('admin', 'accountant')
  async addLine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceLineDto) {
    const [line] = await this.buildLines([dto]);
    return this.editLines(u, id, async (m) => {
      const l = await m.save(InvoiceLine, m.create(InvoiceLine, { ...line, invoiceId: id }));
      await this.audit(m, u, id, 'line_added', l.id, null, lineView(l));
      return l.id;
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
      return l.id;
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

  /**
   * Void (admin/accountant only; teacher/parent 403). Reason required, logged in invoice history.
   * Money already paid moves to the child's credit balance; credit used on the invoice is restored.
   */
  @Post('invoices/:id/void') @Roles('admin', 'accountant') @HttpCode(200)
  async voidInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidDto) {
    const reason = dto.reason?.trim();
    if (!reason) throw BadRequest('Bắt buộc nhập lý do huỷ hoá đơn', 'REASON_REQUIRED');
    await this.ds.transaction((m) => this.voidCore(m, u, id, reason));
    // partial unique index (status <> 'void') frees the (child, period) slot so a corrected invoice can be issued
    return this.getInvoice(u, id);
  }

  private async voidCore(m: EntityManager, u: AuthUser, id: string, reason: string) {
    const i = await m.findOne(Invoice, { where: { id }, relations: { lines: true }, lock: { mode: 'pessimistic_write', tables: ['invoices'] } });
    if (!i) throw NotFound('Không tìm thấy hoá đơn');
    if (i.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'Hoá đơn đã huỷ');
    await m.update(Invoice, id, { status: 'void', note: `[Huỷ] ${reason}${i.note ? ' | ' + i.note : ''}` });
    await this.creditBalance(m, i.childId); // lock child's credit ledger
    const usedCredit = i.lines.filter((l) => l.kind === 'credit').reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    if (usedCredit > 0) await m.save(CreditTransaction, m.create(CreditTransaction, { childId: i.childId, amount: usedCredit, type: 'restored', invoiceId: id,
      note: `Hoàn lại số dư do huỷ hoá đơn ${i.invoiceNo}`, createdBy: u.id }));
    // money already paid on a voided invoice is never lost: it moves to the child's credit balance (PM decision)
    if (i.paidAmount > 0) await m.save(CreditTransaction, m.create(CreditTransaction, { childId: i.childId, amount: i.paidAmount, type: 'void_refund', invoiceId: id,
      note: `Tiền đã nộp cho hoá đơn ${i.invoiceNo} (đã huỷ) chuyển thành số dư`, createdBy: u.id }));
    await this.audit(m, u, id, 'voided', null, { status: i.status, totalAmount: i.totalAmount, paidAmount: i.paidAmount },
      { status: 'void', reason, movedToCredit: i.paidAmount, creditRestored: usedCredit });
    // release refunded meal days / clawbacks so the next invoice (or withdrawal settlement) handles them again
    const lineIds = i.lines.map((l) => l.id);
    if (lineIds.length) {
      await m.delete(MealRefund, { invoiceLineId: In(lineIds) });
      await m.update(MealRefund, { reversedByLineId: In(lineIds) }, { reversedByLineId: null });
    }
    return i;
  }

  // ───── withdrawal (PM decision) ─────
  private async settlementState(m: EntityManager | DataSource, childId: string) {
    const [{ debt, overdue, n }] = await m.query(`SELECT COALESCE(SUM(total_amount - paid_amount),0)::int AS debt,
      COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE due_date < $2),0)::int AS overdue, COUNT(*)::int AS n
      FROM invoices WHERE child_id = $1 AND status IN ('unpaid','partial')`, [childId, overdueCutoff()]);
    const [{ c }] = await m.query('SELECT COALESCE(SUM(amount),0)::int AS c FROM credit_transactions WHERE child_id = $1', [childId]);
    const outstandingDebt = Number(debt), creditBalance = Number(c), netBalance = creditBalance - outstandingDebt;
    return {
      outstandingDebt, overdueDebt: Number(overdue), outstandingInvoiceCount: Number(n), creditBalance, netBalance,
      nextAction: creditBalance > 0 && outstandingDebt === 0 ? 'refund_payout' : outstandingDebt > 0 ? 'collect_debt' : 'none',
      nextActionText: creditBalance > 0 && outstandingDebt === 0 ? `Lập phiếu chi trả lại ${creditBalance.toLocaleString('vi-VN')}đ (POST /children/:id/refund-payouts)`
        : outstandingDebt > 0 ? `Còn nợ ${outstandingDebt.toLocaleString('vi-VN')}đ – vẫn hiện trong /debts đến khi thu đủ` : 'Đã tất toán',
    };
  }

  /**
   * Withdraw a child (admin/accountant). Nothing is deleted. In one transaction:
   * 1) live invoices for periods after the leave month are voided (paid money -> credit);
   * 2) pending meal refunds (notified absences up to leaveDate, 3-month look-back) go to the credit balance,
   *    refunded days whose attendance was corrected are clawed back from it;
   * 3) credit balance is applied to outstanding invoices (oldest first);
   * 4) status 'withdrawn' + leaveDate; pending pickup requests expire.
   * Result: positive balance -> accountant records a refund payout (phiếu chi); debt stays in /debts until paid.
   */
  @Post('children/:id/withdraw') @Roles('admin', 'accountant') @HttpCode(200)
  async withdraw(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawDto) {
    const reason = dto.reason?.trim();
    if (!reason) throw BadRequest('Bắt buộc nhập lý do nghỉ học', 'REASON_REQUIRED');
    const leave = dto.leaveDate.slice(0, 10);
    if (leave > todayStr()) throw BadRequest('Ngày nghỉ học không được ở tương lai; hãy thực hiện vào/sau ngày học cuối', 'LEAVE_DATE_IN_FUTURE');
    const fmt = (d: string) => d.split('-').reverse().join('/');
    const summary = await this.ds.transaction(async (m) => {
      const child = await m.findOne(Child, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!child) throw NotFound('Không tìm thấy trẻ');
      if (child.status === 'withdrawn') throw new AppError(409, 'ALREADY_WITHDRAWN', `Trẻ đã nghỉ học từ ${child.leaveDate}`);
      if (child.enrolledAt && leave < child.enrolledAt) throw BadRequest('Ngày nghỉ trước ngày nhập học', 'INVALID_LEAVE_DATE');
      const lm = leave.slice(0, 7);
      // 1) future-period invoices
      const future = await m.find(Invoice, { where: { childId: id, status: Not('void') } });
      const voided: { id: string; invoiceNo: string; period: string; movedToCredit: number }[] = [];
      for (const inv of future.filter((i) => i.period > lm)) {
        await this.voidCore(m, u, inv.id, `Trẻ nghỉ học từ ${fmt(leave)}`);
        voided.push({ id: inv.id, invoiceNo: inv.invoiceNo, period: inv.period, movedToCredit: inv.paidAmount });
      }
      // 2a) leave month (PM): fixed fees full month, meals only for days actually attended (notified absences therefore not charged)
      await this.creditBalance(m, id);
      const applicable = applicableFees(await this.items.find({ where: { isActive: true, type: In(['monthly', 'discount']) } }), child);
      const meal = mealItemOf(applicable);
      const lmFrom = `${lm}-01`;
      const [{ n: attendedDays }] = await m.query(`SELECT COUNT(*)::int AS n FROM attendance WHERE child_id = $1 AND status IN ('present','late') AND date >= $2 AND date <= $3`, [id, lmFrom, leave]);
      const leaveMonthInfo = await this.settleLeaveMonth(m, u, child, lm, leave, Number(attendedDays), applicable, meal);
      // 2b) meal refunds still pending for months BEFORE the leave month
      let mealRefund = { days: 0, amount: 0, dates: [] as string[] }, clawback = { days: 0, amount: 0 };
      if (meal) {
        const from = `${prevPeriod(prevPeriod(prevPeriod(lm)))}-01`;
        const days: { id: string; date: string }[] = await m.query(`
          SELECT a.id, to_char(a.date, 'YYYY-MM-DD') AS date FROM attendance a
          WHERE a.child_id = $1 AND ${MEAL_REFUNDABLE} AND a.date >= $2 AND a.date <= $3
            AND NOT EXISTS (SELECT 1 FROM meal_refunds r WHERE r.attendance_id = a.id AND ${MR_ACTIVE})
          ORDER BY a.date`, [id, from, addDays(lmFrom, -1)]);
        if (days.length) {
          const rate = meal.mealRefundPerDay!, amount = rate * days.length;
          const tx = await m.save(CreditTransaction, m.create(CreditTransaction, { childId: id, amount, type: 'meal_refund',
            note: `Hoàn tiền ăn ${days.length} ngày nghỉ có báo trước khi tất toán nghỉ học (${days.map((d) => fmt(d.date).slice(0, 5)).join(', ')})`, createdBy: u.id }));
          await m.save(MealRefund, days.map((d) => m.create(MealRefund, { attendanceId: d.id, childId: id, invoiceLineId: null, creditTxId: tx.id, amount: rate })));
          mealRefund = { days: days.length, amount, dates: days.map((d) => d.date) };
        }
      }
      const stale = await this.staleRefunds(m, id);
      if (stale.length) {
        const amount = stale.reduce((s, r) => s + r.amount, 0);
        const tx = await m.save(CreditTransaction, m.create(CreditTransaction, { childId: id, amount: -amount, type: 'meal_clawback',
          note: `Thu lại tiền ăn đã hoàn ${stale.length} ngày (điểm danh đã sửa: ${stale.map((r) => fmt(r.date).slice(0, 5)).join(', ')})`, createdBy: u.id }));
        await m.update(MealRefund, { id: In(stale.map((r) => r.id)) }, { reversedByCreditTxId: tx.id });
        clawback = { days: stale.length, amount };
      }
      // 3) offset credit against outstanding invoices, oldest first
      let credit = await this.creditBalance(m, id, false);
      const applied: { invoiceId: string; invoiceNo: string; amount: number }[] = [];
      const open = await m.find(Invoice, { where: { childId: id, status: In(['unpaid', 'partial']) }, order: { period: 'ASC' } });
      for (const inv of open) {
        if (credit <= 0) break;
        const amt = Math.min(credit, inv.totalAmount - inv.paidAmount);
        if (amt <= 0) continue;
        await this.applyCreditToIssuedInvoice(m, u, inv, amt, `Trừ vào hoá đơn ${inv.invoiceNo} khi tất toán nghỉ học`, 'withdrawal');
        applied.push({ invoiceId: inv.id, invoiceNo: inv.invoiceNo, amount: amt });
        credit -= amt;
      }
      // 4) status
      await m.update(Child, id, { status: 'withdrawn', leaveDate: leave, withdrawalReason: reason, withdrawnAt: new Date(), withdrawnBy: u.id });
      await m.createQueryBuilder().update(PickupRequest).set({ status: 'expired' }).where("child_id = :id AND status = 'pending'", { id }).execute();
      return { voidedInvoices: voided, leaveMonth: leaveMonthInfo, mealRefund, mealClawback: clawback, creditAppliedToInvoices: applied, ...(await this.settlementState(m, id)) };
    });
    return { childId: id, status: 'withdrawn', leaveDate: leave, reason, ...summary };
  }

  /**
   * Leave-month invoice per PM rule. If it does not exist yet it is created (full fixed fees, meals × attended days,
   * plus refunds of earlier notified absences). If it exists, a 'refund' line returns the meal fee for days not attended;
   * the accountant can PATCH that line afterwards. If the invoice was already paid beyond the new total, the excess goes to credit.
   */
  private async settleLeaveMonth(m: EntityManager, u: AuthUser, child: Child, lm: string, leave: string, attendedDays: number, applicable: FeeItem[], meal?: FeeItem) {
    const rate = meal?.mealRefundPerDay ?? 0;
    const base = { period: lm, attendedDays, mealRate: rate };
    const fmt = (d: string) => d.split('-').reverse().join('/');
    const inv = await m.findOne(Invoice, { where: { childId: child.id, period: lm, status: Not('void') }, relations: { lines: true }, lock: { mode: 'pessimistic_write', tables: ['invoices'] } });
    if (!inv) {
      if (!applicable.some((f) => f.type === 'monthly')) return { ...base, invoiceId: null, created: false, mealCharged: 0, mealAdjustment: 0, movedToCredit: 0, warnings: [] };
      const lines = monthlyLines(applicable, attendedDays);
      const refunds = await this.mealRefundDrafts(m, child, lm, applicable);
      lines.push(...refunds.map((r) => r.line));
      const capped = this.capDeductions(lines);
      const created = await this.insertInvoice(m, u, child, lm, this.dueDefault(lm), capped.lines, { note: `Hoá đơn tháng nghỉ học (nghỉ từ ${fmt(leave)})` });
      await this.recordRefunds(m, child, created, refunds);
      const mealCharged = created.lines.filter((l) => l.kind === 'charge' && l.feeItemId === meal?.id && !l.description.startsWith('Thu lại')).reduce((s, l) => s + l.amount, 0);
      return { ...base, invoiceId: created.id, created: true, mealCharged, mealAdjustment: 0, movedToCredit: 0, warnings: capped.warnings };
    }
    const mealLines = meal ? inv.lines.filter((l) => l.kind === 'charge' && l.feeItemId === meal.id && !l.description.startsWith('Thu lại')) : [];
    const charged = mealLines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    let adj = Math.max(0, charged - Math.min(charged, attendedDays * rate));
    const warnings: CapWarning[] = [];
    if (adj > inv.totalAmount) { warnings.push({ code: 'DISCOUNT_CAPPED', message: capMsg(adj, inv.totalAmount), description: 'Hoàn tiền ăn tháng nghỉ', kind: 'refund', requested: adj, applied: inv.totalAmount, discarded: adj - inv.totalAmount }); adj = inv.totalAmount; }
    let movedToCredit = 0;
    if (adj > 0) {
      const line = await m.save(InvoiceLine, m.create(InvoiceLine, { invoiceId: inv.id, feeItemId: meal!.id, kind: 'refund',
        description: `Hoàn tiền ăn tháng nghỉ học: chỉ tính ${attendedDays} ngày đi học thực tế đến ${fmt(leave)}`, quantity: 1, unitPrice: adj, amount: -adj,
        reason: `Nghỉ học từ ${fmt(leave)}` }));
      const total = inv.totalAmount - adj;
      let paid = inv.paidAmount;
      if (paid > total) {
        movedToCredit = paid - total; paid = total;
        await m.save(CreditTransaction, m.create(CreditTransaction, { childId: child.id, amount: movedToCredit, type: 'adjustment', invoiceId: inv.id,
          note: `Tiền ăn tháng nghỉ đã nộp thừa ở hoá đơn ${inv.invoiceNo} chuyển thành số dư`, createdBy: u.id }));
      }
      await m.update(Invoice, inv.id, { totalAmount: total, paidAmount: paid, status: statusOf(total, paid) });
      await this.audit(m, u, inv.id, 'line_added', line.id, null, { ...lineView(line), reason: 'withdrawal_leave_month', movedToCredit });
    }
    return { ...base, invoiceId: inv.id, created: false, mealCharged: charged, mealAdjustment: adj, movedToCredit, warnings };
  }

  /**
   * Credit balance used to settle an invoice that is ALREADY issued: it is a payment by credit, so the invoice total
   * (what was invoiced) stays the same and paid_amount increases. No receipt / payment row is created (the money was
   * already counted when it was first received). Only a NEW invoice takes credit as a 'credit' line before issue (insertInvoice).
   */
  private async applyCreditToIssuedInvoice(m: EntityManager, u: AuthUser, inv: Invoice, amount: number, note: string, reason: string) {
    const fresh = await m.findOneOrFail(Invoice, { where: { id: inv.id }, lock: { mode: 'pessimistic_write' } });
    const amt = Math.min(amount, fresh.totalAmount - fresh.paidAmount);
    if (amt <= 0) return 0;
    const paid = fresh.paidAmount + amt;
    await m.update(Invoice, fresh.id, { paidAmount: paid, status: statusOf(fresh.totalAmount, paid) });
    await m.save(CreditTransaction, m.create(CreditTransaction, { childId: fresh.childId, amount: -amt, type: 'applied', invoiceId: fresh.id, note, createdBy: u.id }));
    await this.audit(m, u, fresh.id, 'credit_applied', null, { totalAmount: fresh.totalAmount, paidAmount: fresh.paidAmount, status: fresh.status },
      { totalAmount: fresh.totalAmount, paidAmount: paid, status: statusOf(fresh.totalAmount, paid), creditApplied: amt, reason });
    return amt;
  }

  /** Current withdrawal / settlement state of a child (+ payouts). */
  @Get('children/:id/withdrawal') @Roles('admin', 'accountant', 'parent')
  async withdrawal(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.access.getChildOr404(id);
    this.assertFinanceChild(u, id);
    const payouts = await this.ds.getRepository(RefundPayout).find({ where: { childId: id }, order: { paidAt: 'ASC' } });
    return { childId: id, fullName: c.fullName, status: c.status, leaveDate: c.leaveDate, reason: c.withdrawalReason, withdrawnAt: c.withdrawnAt,
      ...(await this.settlementState(this.ds, id)),
      payouts: payouts.map((p) => ({ id: p.id, voucherNo: p.voucherNo, amount: p.amount, method: p.method, paidAt: p.paidAt, recipientName: p.recipientName })) };
  }

  /** Phiếu chi: pay a withdrawn child's whole remaining credit back (balance -> 0). */
  @Post('children/:id/refund-payouts') @Roles('admin', 'accountant')
  async payout(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayoutDto) {
    const payoutId = await this.ds.transaction(async (m) => {
      const child = await m.findOne(Child, { where: { id } });
      if (!child) throw NotFound('Không tìm thấy trẻ');
      if (child.status !== 'withdrawn') throw new AppError(409, 'CHILD_NOT_WITHDRAWN', 'Chỉ chi trả số dư cho trẻ đã làm thủ tục nghỉ học; trẻ đang học được trừ vào hoá đơn sau');
      const bal = await this.creditBalance(m, id);
      if (bal <= 0) throw new AppError(409, 'NO_CREDIT_BALANCE', 'Trẻ không có số dư để chi trả');
      const st = await this.settlementState(m, id);
      if (st.outstandingDebt > 0) throw new AppError(409, 'OUTSTANDING_DEBT', `Trẻ còn nợ ${st.outstandingDebt.toLocaleString('vi-VN')}đ; thu/đối trừ nợ trước khi chi trả`);
      if (dto.amount !== undefined && dto.amount !== bal)
        throw new AppError(400, 'AMOUNT_MISMATCH', `Số tiền chi phải bằng toàn bộ số dư ${bal.toLocaleString('vi-VN')}đ`, { creditBalance: bal });
      const [{ n }] = await m.query(`SELECT nextval('payout_no_seq') AS n`);
      const voucherNo = `PC${todayStr().slice(0, 7).replace('-', '')}-${String(n).padStart(5, '0')}`;
      const tx = await m.save(CreditTransaction, m.create(CreditTransaction, { childId: id, amount: -bal, type: 'payout', note: `Chi trả số dư – phiếu chi ${voucherNo}`, createdBy: u.id }));
      const p = await m.save(RefundPayout, m.create(RefundPayout, { voucherNo, childId: id, amount: bal, method: dto.method,
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(), recipientName: dto.recipientName.trim(), note: dto.note ?? null, creditTxId: tx.id, paidBy: u.id }));
      return p.id;
    });
    return this.voucher(u, payoutId);
  }

  /** Data for printing a refund payout voucher (phiếu chi). */
  @Get('refund-payouts/:id/voucher') @Roles('admin', 'accountant', 'parent')
  async voucher(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.ds.getRepository(RefundPayout).findOne({ where: { id }, relations: { payer: true, child: { classRoom: true } } });
    if (!p) throw NotFound('Không tìm thấy phiếu chi');
    this.assertFinanceChild(u, p.childId);
    const creditBalance = Number((await this.ds.query('SELECT COALESCE(SUM(amount),0)::int AS s FROM credit_transactions WHERE child_id = $1', [p.childId]))[0].s);
    return {
      school: schoolInfo(),
      kind: 'refund_payout', title: 'PHIẾU CHI', voucherNo: p.voucherNo, payoutId: p.id, paidAt: p.paidAt, method: p.method,
      recipientName: p.recipientName, amount: p.amount, amountInWords: vndInWords(p.amount),
      reason: `Hoàn trả số dư học phí khi nghỉ học (từ ${p.child.leaveDate?.split('-').reverse().join('/') ?? ''})`, note: p.note,
      paidByName: p.payer?.name ?? null, creditBalanceAfter: creditBalance,
      child: { id: p.childId, fullName: p.child.fullName, className: p.child.classRoom?.name ?? null, leaveDate: p.child.leaveDate },
    };
  }

  /** Pay an invoice. Any amount above the outstanding balance becomes credit for the child (applied next month). */
  @Post('invoices/:id/payments') @Roles('admin', 'accountant')
  async pay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) {
    const paymentId = await this.ds.transaction(async (m) => {
      const i = await m.findOne(Invoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!i) throw NotFound('Không tìm thấy hoá đơn');
      if (i.status === 'void') throw BadRequest('Hoá đơn đã huỷ', 'INVOICE_VOID');
      const balance = i.totalAmount - i.paidAmount;
      if (i.totalAmount === 0) throw new AppError(409, 'ZERO_INVOICE', 'Hoá đơn 0đ (miễn/giảm 100%) không cần thu tiền, không lập phiếu thu; dùng POST /children/:id/prepayments để trả trước');
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
    const child = await this.access.getChildOr404(id);
    if (child.status === 'withdrawn') throw new AppError(409, 'CHILD_WITHDRAWN', 'Trẻ đã nghỉ học; không nhận trả trước');
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

  /** Latest receipt of an invoice. 0đ (miễn/giảm 100%) or unpaid invoices have none -> 404 NO_RECEIPT. */
  @Get('invoices/:id/receipt') @Roles('admin', 'accountant', 'parent')
  async invoiceReceipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const i = await this.invoices.findOne({ where: { id } });
    if (!i) throw NotFound('Không tìm thấy hoá đơn');
    this.assertFinanceChild(u, i.childId);
    const p = await this.payments.findOne({ where: { invoiceId: id }, order: { paidAt: 'DESC' } });
    if (!p) throw new AppError(404, 'NO_RECEIPT', i.totalAmount === 0 && i.status !== 'void'
      ? 'Hoá đơn 0đ (miễn/giảm 100%) không có phiếu thu' : 'Hoá đơn chưa có phiếu thu');
    return this.receipt(u, p.id);
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
      school: schoolInfo(),
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
      .select('i.child_id', 'childId').addSelect('c.full_name', 'fullName').addSelect('c.status', 'childStatus').addSelect("to_char(c.leave_date, 'YYYY-MM-DD')", 'leaveDate').addSelect('c.class_id', 'classId').addSelect('cl.name', 'className')
      .addSelect('SUM(i.total_amount - i.paid_amount)::int', 'balance').addSelect('COUNT(*)::int', 'invoiceCount')
      .addSelect("to_char(MIN(i.due_date), 'YYYY-MM-DD')", 'oldestDueDate')
      .addSelect('COALESCE(SUM(i.total_amount - i.paid_amount) FILTER (WHERE i.due_date < :today), 0)::int', 'overdueAmount')
      .addSelect('COUNT(*) FILTER (WHERE i.due_date < :today)::int', 'overdueInvoiceCount')
      .addSelect('(SELECT COALESCE(SUM(ct.amount),0)::int FROM credit_transactions ct WHERE ct.child_id = i.child_id)', 'creditBalance')
      .where("i.status IN ('unpaid','partial')").setParameter('today', today)
      .groupBy('i.child_id').addGroupBy('c.full_name').addGroupBy('c.status').addGroupBy('c.leave_date').addGroupBy('c.class_id').addGroupBy('cl.name')
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
