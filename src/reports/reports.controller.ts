import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { DataSource } from 'typeorm';
import { Roles } from '../common/auth';
import { overdueCutoff, todayStr } from '../common/dates';
import { BadRequest } from '../common/errors';

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export class MonthRangeQuery {
  @ApiPropertyOptional({ example: '2026-09', description: 'Mặc định: tháng hiện tại' }) @IsOptional() @Matches(PERIOD) fromMonth?: string;
  @ApiPropertyOptional({ example: '2026-10', description: 'Mặc định: tháng hiện tại' }) @IsOptional() @Matches(PERIOD) toMonth?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
}
function range(q: MonthRangeQuery) {
  const cur = todayStr().slice(0, 7);
  const from = q.fromMonth ?? q.toMonth ?? cur, to = q.toMonth ?? (q.fromMonth && q.fromMonth > cur ? q.fromMonth : cur);
  if (from > to) throw BadRequest('fromMonth phải ≤ toMonth', 'INVALID_RANGE');
  const [y, m] = to.split('-').map(Number);
  if ((y - Number(from.slice(0, 4))) * 12 + m - Number(from.slice(5)) > 24) throw BadRequest('Tối đa 24 tháng', 'INVALID_RANGE');
  return { from, to, fromDate: `${from}-01`, toDate: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** Classes below this attendance rate (%) are flagged `low` (shown orange in the web app). */
export const LOW_ATTENDANCE_RATE = Number(process.env.LOW_ATTENDANCE_RATE || 80);

type Col = { header: string; key: string; width?: number; fmt?: 'vnd' | 'pct' | 'int' };
async function sendXlsx(res: Response, filename: string, title: string, sheets: { name: string; cols: Col[]; rows: any[]; total?: any }[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = process.env.SCHOOL_NAME || 'Mầm non'; wb.created = new Date();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name, { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.mergeCells(1, 1, 1, Math.max(1, sh.cols.length));
    ws.getCell(1, 1).value = `${process.env.SCHOOL_NAME || 'Trường Mầm non'} – ${title}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.getRow(3).values = sh.cols.map((c) => c.header);
    ws.getRow(3).font = { bold: true };
    ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD2F5E9' } };
    sh.cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? Math.max(12, c.header.length + 2);
      if (c.fmt === 'vnd') col.numFmt = '#,##0';
      if (c.fmt === 'pct') col.numFmt = '0.0"%"';
    });
    for (const r of sh.rows) ws.addRow(sh.cols.map((c) => r[c.key] ?? null));
    if (sh.total) { const tr = ws.addRow(sh.cols.map((c) => sh.total[c.key] ?? null)); tr.font = { bold: true }; }
  }
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(Buffer.from(buf as ArrayBuffer));
}
const span = (r: { from: string; to: string }) => (r.from === r.to ? r.from : `${r.from}_${r.to}`);

/** Reports. Attendance & enrollment: admin only. Finance: admin + accountant. */
@ApiTags('reports') @ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private ds: DataSource) {}

  /** Attendance rate = (present + late) / recorded child-days, per class per month. */
  @Get('attendance') @Roles('admin')
  async attendance(@Query() q: MonthRangeQuery) {
    const r = range(q);
    const rows: any[] = await this.ds.query(`
      SELECT a.class_id AS "classId", cl.name AS "className", to_char(a.date, 'YYYY-MM') AS month,
        COUNT(*)::int AS recorded,
        COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
        COUNT(*) FILTER (WHERE a.status = 'late')::int AS late,
        COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent,
        COUNT(*) FILTER (WHERE a.status = 'absent' AND a.notified_in_advance)::int AS "absentNotified",
        COUNT(DISTINCT a.date)::int AS "schoolDays"
      FROM attendance a JOIN classes cl ON cl.id = a.class_id
      WHERE a.date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.class_id = $3)
      GROUP BY 1, 2, 3 ORDER BY 3, 2`, [r.fromDate, r.toDate, q.classId ?? null]);
    const items = rows.map((x) => { const rate = pct(x.present + x.late, x.recorded); return { ...x, attendanceRate: rate, low: rate !== null && rate < LOW_ATTENDANCE_RATE }; });
    const t = items.reduce((s, x) => ({ recorded: s.recorded + x.recorded, attended: s.attended + x.present + x.late, absent: s.absent + x.absent }),
      { recorded: 0, attended: 0, absent: 0 });
    return { fromMonth: r.from, toMonth: r.to, lowThreshold: LOW_ATTENDANCE_RATE, totals: { ...t, attendanceRate: pct(t.attended, t.recorded) }, items };
  }

  /** Same data as /reports/attendance as an .xlsx file. */
  @Get('attendance/export') @Roles('admin')
  async attendanceXlsx(@Query() q: MonthRangeQuery, @Res() res: Response) {
    const d = await this.attendance(q);
    await sendXlsx(res, `chuyen-can_${span({ from: d.fromMonth, to: d.toMonth })}.xlsx`, `Báo cáo chuyên cần ${d.fromMonth}${d.fromMonth === d.toMonth ? '' : ' → ' + d.toMonth}`, [{
      name: 'Chuyên cần', cols: [
        { header: 'Tháng', key: 'month', width: 10 }, { header: 'Lớp', key: 'className', width: 14 }, { header: 'Số ngày học', key: 'schoolDays' },
        { header: 'Lượt điểm danh', key: 'recorded', width: 16 }, { header: 'Có mặt', key: 'present' }, { header: 'Đi muộn', key: 'late' },
        { header: 'Vắng', key: 'absent' }, { header: 'Vắng có báo', key: 'absentNotified', width: 14 }, { header: 'Tỷ lệ (%)', key: 'attendanceRate', fmt: 'pct' },
        { header: `Dưới ${d.lowThreshold}%`, key: 'lowText' },
      ],
      rows: d.items.map((x: any) => ({ ...x, lowText: x.low ? 'Cần chú ý' : '' })),
      total: { month: 'Tổng', recorded: d.totals.recorded, absent: d.totals.absent, attendanceRate: d.totals.attendanceRate },
    }]);
  }

  @Get('enrollment') @Roles('admin')
  async enrollment() {
    const byClass: any[] = await this.ds.query(`
      SELECT cl.id AS "classId", cl.name AS "className", cl.age_group AS "ageGroup", cl.capacity,
        COUNT(c.id) FILTER (WHERE c.status = 'active')::int AS active,
        COUNT(c.id) FILTER (WHERE c.status = 'active' AND c.gender = 'M')::int AS male,
        COUNT(c.id) FILTER (WHERE c.status = 'active' AND c.gender = 'F')::int AS female
      FROM classes cl LEFT JOIN children c ON c.class_id = cl.id
      GROUP BY cl.id ORDER BY cl.name`);
    const [tot] = await this.ds.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn,
        COUNT(*) FILTER (WHERE status = 'active' AND class_id IS NULL)::int AS unassigned FROM children`);
    const byMonth: any[] = await this.ds.query(`
      SELECT to_char(enrolled_at, 'YYYY-MM') AS month, COUNT(*)::int AS enrolled FROM children
      WHERE enrolled_at >= (date_trunc('month', now()) - interval '11 months')::date GROUP BY 1 ORDER BY 1`);
    const capacity = byClass.reduce((s, c) => s + (c.capacity ?? 0), 0);
    return {
      asOf: todayStr(), totals: { ...tot, capacity, fillRate: pct(tot.active, capacity) },
      byClass: byClass.map((c) => ({ ...c, fillRate: c.capacity ? pct(c.active, c.capacity) : null })),
      newEnrollmentsByMonth: byMonth,
    };
  }

  @Get('enrollment/export') @Roles('admin')
  async enrollmentXlsx(@Res() res: Response) {
    const d = await this.enrollment();
    await sendXlsx(res, `si-so_${d.asOf}.xlsx`, `Báo cáo sĩ số ngày ${d.asOf.split('-').reverse().join('/')}`, [
      { name: 'Theo lớp', cols: [
          { header: 'Lớp', key: 'className', width: 14 }, { header: 'Khối', key: 'ageGroup', width: 14 }, { header: 'Sức chứa', key: 'capacity' },
          { header: 'Đang học', key: 'active' }, { header: 'Nam', key: 'male' }, { header: 'Nữ', key: 'female' }, { header: 'Lấp đầy (%)', key: 'fillRate', fmt: 'pct' }],
        rows: d.byClass, total: { className: 'Toàn trường', capacity: d.totals.capacity, active: d.totals.active, fillRate: d.totals.fillRate } },
      { name: 'Nhập học mới', cols: [{ header: 'Tháng', key: 'month' }, { header: 'Số trẻ nhập học', key: 'enrolled', width: 18 }], rows: d.newEnrollmentsByMonth },
      { name: 'Tổng hợp', cols: [{ header: 'Chỉ số', key: 'k', width: 24 }, { header: 'Giá trị', key: 'v' }], rows: [
        { k: 'Đang học', v: d.totals.active }, { k: 'Đã nghỉ học', v: d.totals.withdrawn }, { k: 'Chưa xếp lớp', v: d.totals.unassigned },
        { k: 'Sức chứa', v: d.totals.capacity }, { k: 'Lấp đầy (%)', v: d.totals.fillRate }] },
    ]);
  }

  /**
   * Per invoice period: invoiced, collected against those invoices, outstanding (debt) and overdue.
   * Plus cash collections by payment month (incl. prepayments) and current credit balance.
   */
  @Get('finance') @Roles('admin', 'accountant')
  async finance(@Query() q: MonthRangeQuery) {
    const r = range(q);
    const today = todayStr(), cutoff = overdueCutoff();
    const byPeriod: any[] = await this.ds.query(`
      SELECT i.period AS month, COUNT(*)::int AS "invoiceCount",
        COALESCE(SUM(i.total_amount),0)::bigint AS invoiced, COALESCE(SUM(i.paid_amount),0)::bigint AS collected,
        COALESCE(SUM(i.total_amount - i.paid_amount),0)::bigint AS outstanding,
        COALESCE(SUM(i.total_amount - i.paid_amount) FILTER (WHERE i.status <> 'paid' AND i.due_date < $3),0)::bigint AS overdue,
        COUNT(*) FILTER (WHERE i.status = 'paid')::int AS paid, COUNT(*) FILTER (WHERE i.status = 'partial')::int AS partial,
        COUNT(*) FILTER (WHERE i.status = 'unpaid')::int AS unpaid
      FROM invoices i WHERE i.status <> 'void' AND i.period BETWEEN $1 AND $2 AND ($4::uuid IS NULL OR i.class_id = $4)
      GROUP BY 1 ORDER BY 1`, [r.from, r.to, cutoff, q.classId ?? null]);
    const deductions: any[] = await this.ds.query(`
      SELECT i.period AS month, l.kind, COALESCE(SUM(-l.amount),0)::bigint AS amount
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.status <> 'void' AND l.kind <> 'charge' AND i.period BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR i.class_id = $3)
      GROUP BY 1, 2`, [r.from, r.to, q.classId ?? null]);
    const cash: any[] = await this.ds.query(`
      SELECT to_char(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS month,
        COALESCE(SUM(p.amount),0)::bigint AS total,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'cash'),0)::bigint AS cash,
        COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'transfer'),0)::bigint AS transfer,
        COALESCE(SUM(p.credit_amount),0)::bigint AS "toCredit", COUNT(*)::int AS receipts
      FROM payments p ${q.classId ? 'JOIN children c ON c.id = p.child_id' : ''}
      WHERE (p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2 ${q.classId ? 'AND c.class_id = $3' : ''}
      GROUP BY 1 ORDER BY 1`, q.classId ? [r.fromDate, r.toDate, q.classId] : [r.fromDate, r.toDate]);
    const [debt] = await this.ds.query(`
      SELECT COALESCE(SUM(total_amount - paid_amount),0)::bigint AS "totalDebt",
        COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE due_date < $1),0)::bigint AS "totalOverdue"
      FROM invoices WHERE status IN ('unpaid','partial')`, [cutoff]);
    const [credit] = await this.ds.query(`SELECT COALESCE(SUM(amount),0)::bigint AS "totalCredit" FROM credit_transactions`);
    // chi: refund payouts (phiếu chi) to withdrawn children's families
    const payouts: any[] = await this.ds.query(`
      SELECT to_char(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS month, COALESCE(SUM(p.amount),0)::bigint AS total, COUNT(*)::int AS vouchers
      FROM refund_payouts p ${q.classId ? 'JOIN children c ON c.id = p.child_id' : ''}
      WHERE (p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1 AND $2 ${q.classId ? 'AND c.class_id = $3' : ''}
      GROUP BY 1 ORDER BY 1`, q.classId ? [r.fromDate, r.toDate, q.classId] : [r.fromDate, r.toDate]);
    const n = (v: any) => Number(v);
    return {
      fromMonth: r.from, toMonth: r.to, asOf: today,
      current: { totalDebt: n(debt.totalDebt), totalOverdue: n(debt.totalOverdue), totalCreditBalance: n(credit.totalCredit) },
      byPeriod: byPeriod.map((x) => ({
        month: x.month, invoiceCount: x.invoiceCount, invoiced: n(x.invoiced), collected: n(x.collected), outstanding: n(x.outstanding),
        overdue: n(x.overdue), collectionRate: pct(n(x.collected), n(x.invoiced)), paid: x.paid, partial: x.partial, unpaid: x.unpaid,
        deductions: Object.fromEntries(['discount', 'refund', 'credit'].map((k) => [k, n(deductions.find((d) => d.month === x.month && d.kind === k)?.amount ?? 0)])),
      })),
      collectionsByPaymentMonth: cash.map((x) => ({ month: x.month, total: n(x.total), cash: n(x.cash), transfer: n(x.transfer), toCredit: n(x.toCredit), receipts: x.receipts })),
      /** Thu – chi theo tháng: thu = phiếu thu, chi = phiếu chi hoàn số dư khi nghỉ học. */
      cashFlowByMonth: [...new Set([...cash.map((x) => x.month), ...payouts.map((x) => x.month)])].sort().map((month) => {
        const inc = n(cash.find((x) => x.month === month)?.total ?? 0), out = n(payouts.find((x) => x.month === month)?.total ?? 0);
        return { month, income: inc, expense: out, net: inc - out, receipts: cash.find((x) => x.month === month)?.receipts ?? 0, vouchers: payouts.find((x) => x.month === month)?.vouchers ?? 0 };
      }),
    };
  }

  @Get('finance/export') @Roles('admin', 'accountant')
  async financeXlsx(@Query() q: MonthRangeQuery, @Res() res: Response) {
    const d = await this.finance(q);
    const vnd = (k: string, h: string, w = 16): Col => ({ header: h, key: k, width: w, fmt: 'vnd' });
    const sum = (rows: any[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + (r[k] ?? 0), 0)]));
    await sendXlsx(res, `thu-chi_${span({ from: d.fromMonth, to: d.toMonth })}.xlsx`, `Báo cáo thu chi ${d.fromMonth}${d.fromMonth === d.toMonth ? '' : ' → ' + d.toMonth}`, [
      { name: 'Học phí theo kỳ', cols: [{ header: 'Kỳ', key: 'month', width: 10 }, { header: 'Số HĐ', key: 'invoiceCount' }, vnd('invoiced', 'Phải thu'),
          vnd('collected', 'Đã thu'), vnd('outstanding', 'Còn nợ'), vnd('overdue', 'Quá hạn'), { header: 'Tỷ lệ thu (%)', key: 'collectionRate', fmt: 'pct', width: 14 },
          vnd('discount', 'Giảm trừ'), vnd('refund', 'Hoàn tiền ăn'), vnd('credit', 'Trừ số dư')],
        rows: d.byPeriod.map((x) => ({ ...x, ...x.deductions })),
        total: { month: 'Tổng', ...sum(d.byPeriod.map((x) => ({ ...x, ...x.deductions })), ['invoiceCount', 'invoiced', 'collected', 'outstanding', 'overdue', 'discount', 'refund', 'credit']) } },
      { name: 'Thu chi theo tháng', cols: [{ header: 'Tháng', key: 'month', width: 10 }, vnd('income', 'Thu'), vnd('expense', 'Chi (phiếu chi)'), vnd('net', 'Chênh lệch'),
          { header: 'Số phiếu thu', key: 'receipts', width: 14 }, { header: 'Số phiếu chi', key: 'vouchers', width: 14 }],
        rows: d.cashFlowByMonth, total: { month: 'Tổng', ...sum(d.cashFlowByMonth, ['income', 'expense', 'net', 'receipts', 'vouchers']) } },
      { name: 'Tiền thu', cols: [{ header: 'Tháng', key: 'month', width: 10 }, vnd('total', 'Tổng thu'), vnd('cash', 'Tiền mặt'), vnd('transfer', 'Chuyển khoản'),
          vnd('toCredit', 'Vào số dư'), { header: 'Số phiếu', key: 'receipts' }], rows: d.collectionsByPaymentMonth },
      { name: 'Hiện tại', cols: [{ header: 'Chỉ số', key: 'k', width: 26 }, vnd('v', 'Số tiền')], rows: [
        { k: 'Tổng công nợ', v: d.current.totalDebt }, { k: 'Trong đó quá hạn', v: d.current.totalOverdue }, { k: 'Tổng số dư (trả trước/thừa)', v: d.current.totalCreditBalance }] },
    ]);
  }
}
