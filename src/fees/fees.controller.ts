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
import { todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { vndInWords } from '../common/money';
import { Child, FeeItem, FeeScope, FeeType, Invoice, InvoiceLine, Payment } from '../database/entities';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_VND = 1_000_000_000;

export class FeeItemQuery {
  @ApiPropertyOptional({ enum: ['school', 'class', 'child'] }) @IsOptional() @IsIn(['school', 'class', 'child']) scope?: FeeScope;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false', 'all'], default: 'true' }) @IsOptional() @IsIn(['true', 'false', 'all']) active?: string;
}
export class CreateFeeItemDto {
  @ApiProperty({ example: 'Học phí' }) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiProperty({ example: 1500000, description: 'VND' }) @IsInt() @Min(0) @Max(MAX_VND) amount!: number;
  @ApiProperty({ enum: ['monthly', 'one_time'] }) @IsIn(['monthly', 'one_time']) type!: FeeType;
  @ApiProperty({ enum: ['school', 'class', 'child'], description: 'school: mọi trẻ; class: cần classId; child: cần childId' })
  @IsIn(['school', 'class', 'child']) scope!: FeeScope;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateFeeItemDto extends PartialType(CreateFeeItemDto) {}

export class GenerateInvoicesDto {
  @ApiProperty({ example: '2026-10' }) @Matches(PERIOD) period!: string;
  @ApiPropertyOptional({ description: 'Chỉ lập cho 1 lớp' }) @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ example: '2026-10-10', description: 'Mặc định ngày 10 của tháng' }) @IsOptional() @IsDateString() dueDate?: string;
}
class InvoiceLineDto {
  @ApiPropertyOptional({ description: 'Lấy tên/giá từ khoản thu' }) @IsOptional() @IsUUID() feeItemId?: string;
  @ApiPropertyOptional({ example: 'Đồng phục' }) @IsOptional() @IsString() @MinLength(1) @MaxLength(200) description?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(1000) quantity?: number;
  @ApiPropertyOptional({ example: 250000, description: 'Âm = giảm trừ' }) @IsOptional() @IsInt() @Min(-MAX_VND) @Max(MAX_VND) unitPrice?: number;
}
export class CreateInvoiceDto {
  @ApiProperty() @IsUUID() childId!: string;
  @ApiProperty({ example: '2026-10' }) @Matches(PERIOD) period!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiProperty({ type: [InvoiceLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines!: InvoiceLineDto[];
}
export class InvoiceQuery {
  @ApiPropertyOptional({ example: '2026-10' }) @IsOptional() @Matches(PERIOD) period?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ enum: ['unpaid', 'partial', 'paid', 'void', 'outstanding'] }) @IsOptional() @IsIn(['unpaid', 'partial', 'paid', 'void', 'outstanding']) status?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(300) limit?: number;
}
export class VoidDto { @ApiProperty({ example: 'Lập nhầm' }) @IsString() @MinLength(1) @MaxLength(500) reason!: string; }
export class PaymentDto {
  @ApiProperty({ example: 1500000 }) @IsInt() @Min(1) @Max(MAX_VND) amount!: number;
  @ApiProperty({ enum: ['cash', 'transfer'] }) @IsIn(['cash', 'transfer']) method!: 'cash' | 'transfer';
  @ApiPropertyOptional({ description: 'ISO 8601, mặc định bây giờ' }) @IsOptional() @IsISO8601() paidAt?: string;
  @ApiPropertyOptional({ example: 'Nguyễn Văn Hùng' }) @IsOptional() @IsString() @MaxLength(120) payerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class DebtQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ description: 'Chỉ tính hoá đơn đến kỳ này (YYYY-MM)' }) @IsOptional() @Matches(PERIOD) upToPeriod?: string;
}

const statusOf = (total: number, paid: number): Invoice['status'] => (paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial');
const lineView = (l: InvoiceLine) => ({ id: l.id, feeItemId: l.feeItemId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount });
const paymentView = (p: Payment) => ({
  id: p.id, receiptNo: p.receiptNo, invoiceId: p.invoiceId, amount: p.amount, method: p.method, paidAt: p.paidAt,
  payerName: p.payerName, note: p.note, receivedBy: p.receivedBy, receivedByName: p.receiver?.name ?? null,
});
const invoiceView = (i: Invoice, detail = false) => ({
  id: i.id, invoiceNo: i.invoiceNo, childId: i.childId, childName: i.child?.fullName, classId: i.classId, className: i.classRoom?.name ?? null,
  period: i.period, issueDate: i.issueDate, dueDate: i.dueDate, totalAmount: i.totalAmount, paidAmount: i.paidAmount,
  balance: i.status === 'void' ? 0 : i.totalAmount - i.paidAmount, status: i.status, note: i.note,
  overdue: i.status !== 'void' && i.status !== 'paid' && i.dueDate < todayStr(),
  ...(detail ? { lines: (i.lines ?? []).map(lineView), payments: (i.payments ?? []).map(paymentView) } : {}),
});

/**
 * Fees & debts. Admin + accountant manage everything; parent reads invoices/receipts/balance of own children only;
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
    private access: AccessService, private ds: DataSource,
  ) {}

  private assertFinanceChild(u: AuthUser, childId: string) {
    if (u.role === 'admin' || u.role === 'accountant') return;
    if (u.role === 'parent' && u.childIds.includes(childId)) return;
    throw Forbidden('Không có quyền xem học phí của trẻ này');
  }
  private dueDefault(period: string) { return `${period}-10`; }

  // ───── fee items ─────
  @Get('fee-items') @Roles('admin', 'accountant')
  async listItems(@Query() q: FeeItemQuery) {
    const where: any = {};
    if (q.scope) where.scope = q.scope;
    if (q.classId) where.classId = q.classId;
    if (q.childId) where.childId = q.childId;
    if ((q.active ?? 'true') !== 'all') where.isActive = (q.active ?? 'true') === 'true';
    return this.items.find({ where, order: { scope: 'ASC', name: 'ASC' } });
  }

  private async validateScope(dto: Partial<CreateFeeItemDto>, base?: FeeItem) {
    const scope = dto.scope ?? base?.scope;
    const classId = dto.classId !== undefined ? dto.classId : base?.classId;
    const childId = dto.childId !== undefined ? dto.childId : base?.childId;
    if (scope === 'school' && (classId || childId)) throw BadRequest('Khoản thu toàn trường không gắn lớp/trẻ', 'INVALID_SCOPE');
    if (scope === 'class') {
      if (!classId || childId) throw BadRequest('Khoản thu theo lớp cần classId (không có childId)', 'INVALID_SCOPE');
      await this.access.getClassOr404(classId);
    }
    if (scope === 'child') {
      if (!childId || classId) throw BadRequest('Khoản thu riêng cần childId (không có classId)', 'INVALID_SCOPE');
      await this.access.getChildOr404(childId);
    }
    return { scope, classId: classId ?? null, childId: childId ?? null };
  }

  @Post('fee-items') @Roles('admin', 'accountant')
  async createItem(@Body() dto: CreateFeeItemDto) {
    const s = await this.validateScope(dto);
    return this.items.save(this.items.create({ ...dto, ...s }));
  }

  @Patch('fee-items/:id') @Roles('admin', 'accountant')
  async updateItem(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFeeItemDto) {
    const it = await this.items.findOne({ where: { id } });
    if (!it) throw NotFound('Không tìm thấy khoản thu');
    const s = await this.validateScope(dto, it);
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

  private async insertInvoice(m: EntityManager, u: AuthUser, child: Child, period: string, dueDate: string, lines: Partial<InvoiceLine>[], note?: string | null) {
    const total = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
    if (total < 0) throw BadRequest('Tổng hoá đơn không được âm', 'NEGATIVE_TOTAL');
    return m.save(Invoice, m.create(Invoice, {
      invoiceNo: await this.nextNo(m, 'invoice_no_seq', 'HD', period), childId: child.id, classId: child.classId, period,
      issueDate: todayStr(), dueDate, totalAmount: total, paidAmount: 0, status: total === 0 ? 'paid' : 'unpaid', note: note ?? null,
      createdBy: u.id, lines: lines as InvoiceLine[],
    }));
  }

  /** Monthly invoices for all active children (or one class): school + class + child-specific monthly fee items. Skips children already invoiced for the period. */
  @Post('invoices/generate') @Roles('admin', 'accountant')
  async generate(@CurrentUser() u: AuthUser, @Body() dto: GenerateInvoicesDto) {
    if (dto.classId) await this.access.getClassOr404(dto.classId);
    const kids = await this.children.find({ where: { status: 'active', ...(dto.classId ? { classId: dto.classId } : {}) }, order: { fullName: 'ASC' } });
    const fees = await this.items.find({ where: { isActive: true, type: 'monthly' } });
    const existing = new Set((await this.invoices.find({ where: { period: dto.period, status: Not('void'), childId: In(kids.length ? kids.map((k) => k.id) : ['00000000-0000-0000-0000-000000000000']) } })).map((i) => i.childId));
    const created: Invoice[] = [];
    await this.ds.transaction(async (m) => {
      for (const k of kids) {
        if (existing.has(k.id)) continue;
        const applicable = fees.filter((f) => f.scope === 'school' || (f.scope === 'class' && f.classId === k.classId) || (f.scope === 'child' && f.childId === k.id));
        if (!applicable.length) continue;
        const lines = applicable.map((f) => ({ feeItemId: f.id, description: f.name, quantity: 1, unitPrice: f.amount, amount: f.amount }));
        created.push(await this.insertInvoice(m, u, k, dto.period, dto.dueDate ?? this.dueDefault(dto.period), lines));
      }
    });
    return {
      period: dto.period, created: created.length, skippedExisting: kids.filter((k) => existing.has(k.id)).length,
      totalAmount: created.reduce((s, i) => s + i.totalAmount, 0), invoiceIds: created.map((i) => i.id),
    };
  }

  /** Manual invoice (e.g. one-time fees, adjustments). One invoice per child per period. */
  @Post('invoices') @Roles('admin', 'accountant')
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateInvoiceDto) {
    const child = await this.access.getChildOr404(dto.childId);
    const feeIds = dto.lines.map((l) => l.feeItemId).filter(Boolean) as string[];
    const fees = feeIds.length ? await this.items.find({ where: { id: In(feeIds) } }) : [];
    const lines = dto.lines.map((l) => {
      const f = l.feeItemId ? fees.find((x) => x.id === l.feeItemId) : undefined;
      if (l.feeItemId && !f) throw BadRequest('Khoản thu không tồn tại', 'INVALID_FEE_ITEM');
      const description = l.description ?? f?.name, unitPrice = l.unitPrice ?? f?.amount, quantity = l.quantity ?? 1;
      if (!description || unitPrice === undefined) throw BadRequest('Dòng hoá đơn cần feeItemId hoặc description + unitPrice', 'INVALID_LINE');
      return { feeItemId: f?.id ?? null, description, quantity, unitPrice, amount: unitPrice * quantity };
    });
    if (await this.invoices.exist({ where: { childId: child.id, period: dto.period, status: Not('void') } }))
      throw new AppError(409, 'INVOICE_EXISTS', 'Trẻ đã có hoá đơn kỳ này; huỷ hoá đơn cũ hoặc chọn kỳ khác');
    const inv = await this.ds.transaction((m) => this.insertInvoice(m, u, child, dto.period, dto.dueDate ?? this.dueDefault(dto.period), lines, dto.note));
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

  @Post('invoices/:id/void') @Roles('admin', 'accountant') @HttpCode(200)
  async voidInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidDto) {
    await this.ds.transaction(async (m) => {
      const i = await m.findOne(Invoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!i) throw NotFound('Không tìm thấy hoá đơn');
      if (i.status === 'void') throw new AppError(409, 'ALREADY_VOID', 'Hoá đơn đã huỷ');
      if (i.paidAmount > 0) throw new AppError(409, 'HAS_PAYMENTS', 'Hoá đơn đã có thanh toán, không thể huỷ');
      await m.update(Invoice, id, { status: 'void', note: `[Huỷ] ${dto.reason}${i.note ? ' | ' + i.note : ''}` });
    });
    // partial unique index (status <> 'void') frees the (child, period) slot so a corrected invoice can be issued
    return this.getInvoice(u, id);
  }

  @Post('invoices/:id/payments') @Roles('admin', 'accountant')
  async pay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) {
    const paymentId = await this.ds.transaction(async (m) => {
      const i = await m.findOne(Invoice, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!i) throw NotFound('Không tìm thấy hoá đơn');
      if (i.status === 'void') throw BadRequest('Hoá đơn đã huỷ', 'INVOICE_VOID');
      const balance = i.totalAmount - i.paidAmount;
      if (balance <= 0) throw new AppError(409, 'ALREADY_PAID', 'Hoá đơn đã thanh toán đủ');
      if (dto.amount > balance) throw BadRequest(`Số tiền vượt quá số còn nợ (${balance})`, 'OVERPAYMENT');
      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      const p = await m.save(Payment, m.create(Payment, {
        receiptNo: await this.nextNo(m, 'receipt_no_seq', 'PT', i.period), invoiceId: id, amount: dto.amount, method: dto.method,
        paidAt, payerName: dto.payerName ?? null, note: dto.note ?? null, receivedBy: u.id,
      }));
      const paid = i.paidAmount + dto.amount;
      await m.update(Invoice, id, { paidAmount: paid, status: statusOf(i.totalAmount, paid) });
      return p.id;
    });
    return this.receipt(u, paymentId);
  }

  /** Data for printing a receipt (phiếu thu). */
  @Get('payments/:id/receipt') @Roles('admin', 'accountant', 'parent')
  async receipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.payments.findOne({ where: { id }, relations: { receiver: true, invoice: { child: true, classRoom: true, lines: true } } });
    if (!p) throw NotFound('Không tìm thấy phiếu thu');
    this.assertFinanceChild(u, p.invoice.childId);
    const i = p.invoice;
    return {
      school: { name: process.env.SCHOOL_NAME || 'Trường Mầm non', address: process.env.SCHOOL_ADDRESS || null, phone: process.env.SCHOOL_PHONE || null },
      receiptNo: p.receiptNo, paymentId: p.id, paidAt: p.paidAt, method: p.method, payerName: p.payerName,
      amount: p.amount, amountInWords: vndInWords(p.amount), note: p.note, receivedByName: p.receiver?.name ?? null,
      child: { id: i.childId, fullName: i.child.fullName, className: i.classRoom?.name ?? null },
      invoice: { id: i.id, invoiceNo: i.invoiceNo, period: i.period, totalAmount: i.totalAmount, paidAmount: i.paidAmount,
        balanceAfter: i.totalAmount - i.paidAmount, status: i.status, lines: i.lines.map(lineView) },
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
    return {
      childId: id, fullName: child.fullName, className: child.classRoom?.name ?? null, totalInvoiced, totalPaid, balance: totalInvoiced - totalPaid,
      outstanding: live.filter((i) => i.paidAmount < i.totalAmount).map((i) => invoiceView(i)),
    };
  }

  @Get('debts') @Roles('admin', 'accountant')
  async debts(@Query() q: DebtQuery) {
    const qb = this.invoices.createQueryBuilder('i').innerJoin('i.child', 'c').leftJoin('c.classRoom', 'cl')
      .select('i.child_id', 'childId').addSelect('c.full_name', 'fullName').addSelect('c.class_id', 'classId').addSelect('cl.name', 'className')
      .addSelect('SUM(i.total_amount - i.paid_amount)', 'balance').addSelect('COUNT(*)', 'invoiceCount').addSelect("to_char(MIN(i.due_date), 'YYYY-MM-DD')", 'oldestDueDate')
      .where("i.status IN ('unpaid','partial')").groupBy('i.child_id').addGroupBy('c.full_name').addGroupBy('c.class_id').addGroupBy('cl.name')
      .orderBy('balance', 'DESC');
    if (q.classId) qb.andWhere('c.class_id = :cl', { cl: q.classId });
    if (q.upToPeriod) qb.andWhere('i.period <= :p', { p: q.upToPeriod });
    const rows = await qb.getRawMany();
    const items = rows.map((r) => ({ ...r, balance: Number(r.balance), invoiceCount: Number(r.invoiceCount), overdue: r.oldestDueDate < todayStr() }));
    return { totalDebt: items.reduce((s, r) => s + r.balance, 0), childCount: items.length, items };
  }
}
