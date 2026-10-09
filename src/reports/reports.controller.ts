import { Controller, Get, Query } from '@nestjs/common';
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
    const items = rows.map((x) => ({ ...x, attendanceRate: pct(x.present + x.late, x.recorded) }));
    const t = items.reduce((s, x) => ({ recorded: s.recorded + x.recorded, attended: s.attended + x.present + x.late, absent: s.absent + x.absent }),
      { recorded: 0, attended: 0, absent: 0 });
    return { fromMonth: r.from, toMonth: r.to, totals: { ...t, attendanceRate: pct(t.attended, t.recorded) }, items };
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
    };
  }
}
