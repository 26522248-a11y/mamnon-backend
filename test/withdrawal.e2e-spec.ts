process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';

const nextMonth = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

describe('PM round 3: void rules, withdrawal & payout, discount cap, account security (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const login = (username: string, password = '123456') => request(http).post('/api/v1/auth/login').send({ username, password });
  const as = (who: string) => {
    const t = () => ({ Authorization: `Bearer ${tokens[who]}` });
    return {
      get: (url: string) => request(http).get('/api/v1' + url).set(t()),
      post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(t()).send(body),
      put: (url: string, body?: any) => request(http).put('/api/v1' + url).set(t()).send(body),
      patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set(t()).send(body),
      del: (url: string) => request(http).delete('/api/v1' + url).set(t()),
    };
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'ketoan', 'ph1']) tokens[u] = (await login(u)).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });

  const today = todayStr(), leave = addDays(today, -1);
  const thisMonth = today.slice(0, 7), next = nextMonth(thisMonth);
  const c1 = () => s.classes.c1.id;
  const credit = async (childId: string) => (await as('ketoan').get(`/children/${childId}/credits`).expect(200)).body.creditBalance as number;
  const invOf = async (childId: string, period: string) => (await as('ketoan').get(`/invoices?childId=${childId}&period=${period}`).expect(200)).body.items[0];
  const payAll = async (childId: string) => {
    const b = (await as('ketoan').get(`/children/${childId}/balance`).expect(200)).body;
    for (const i of b.outstanding) await as('ketoan').post(`/invoices/${i.id}/payments`, { amount: i.balance, method: 'cash' }).expect(201);
  };

  describe('void paid invoice (PM)', () => {
    it('only accountant/admin, reason required, logged in history, paid money -> credit', async () => {
      const k = s.kids[3];
      const inv = await invOf(k.id, s.periods.lastMonth);
      expect(inv.paidAmount).toBeGreaterThan(0);
      await as('gv1').post(`/invoices/${inv.id}/void`, { reason: 'x' }).expect(403);
      await as('ph1').post(`/invoices/${inv.id}/void`, { reason: 'x' }).expect(403);
      expect((await as('ketoan').post(`/invoices/${inv.id}/void`, { reason: '   ' }).expect(400)).body.code).toBe('REASON_REQUIRED');
      expect((await as('ketoan').post(`/invoices/${inv.id}/void`, {}).expect(400)).body.code).toBe('VALIDATION_ERROR');
      const before = await credit(k.id);
      await as('ketoan').post(`/invoices/${inv.id}/void`, { reason: 'Lập sai kỳ' }).expect(200);
      expect(await credit(k.id)).toBe(before + inv.paidAmount);
      const h = (await as('admin').get(`/invoices/${inv.id}/history`).expect(200)).body;
      expect(h.find((x: any) => x.action === 'voided')).toMatchObject({ changedBy: s.users.ketoan.id, new: { reason: 'Lập sai kỳ', movedToCredit: inv.paidAmount } });
    });
  });

  describe('discount larger than the invoice (PM: cap at 0đ, excess discarded, warning)', () => {
    it('manual invoice: no more 400; capped to 0 with warning; no credit created', async () => {
      const k = s.kids[18];
      const before = await credit(k.id);
      const r = await as('ketoan').post('/invoices', { childId: k.id, period: '2027-08', applyCredit: false, lines: [
        { description: 'Đồng phục', unitPrice: 300000 }, { kind: 'discount', description: 'Học bổng', unitPrice: 500000, reason: 'Học bổng HK1' }] }).expect(201);
      expect(r.body).toMatchObject({ totalAmount: 0, status: 'paid' });
      expect(r.body.warnings).toEqual([expect.objectContaining({ code: 'DISCOUNT_CAPPED', requested: 500000, applied: 300000, discarded: 200000 })]);
      expect(r.body.lines.find((l: any) => l.kind === 'discount')).toMatchObject({ amount: -300000 });
      expect(await credit(k.id)).toBe(before);
    });
    it('adding a too-large discount line to an existing invoice is capped too', async () => {
      const k = s.kids[18];
      const r = await as('ketoan').post('/invoices', { childId: k.id, period: '2027-09', applyCredit: false, lines: [{ description: 'Dã ngoại', unitPrice: 300000 }] }).expect(201);
      expect(r.body.warnings).toEqual([]);
      const add = await as('ketoan').post(`/invoices/${r.body.id}/lines`, { kind: 'discount', description: 'Miễn phí', unitPrice: 400000, reason: 'Hoàn cảnh khó khăn' }).expect(201);
      expect(add.body.totalAmount).toBe(0);
      expect(add.body.warnings[0]).toMatchObject({ requested: 400000, applied: 300000, discarded: 100000 });
    });
    it('auto generation: same rule, warning lists the child', async () => {
      const k = s.kids[21];
      await as('ketoan').post('/fee-items', { name: 'Miễn học phí', amount: 5000000, type: 'discount', scope: 'child', childId: k.id, reason: 'Diện chính sách' }).expect(201);
      const g = await as('ketoan').post('/invoices/generate', { period: '2027-10', classId: c1() }).expect(201);
      const w = g.body.warnings.find((x: any) => x.childId === k.id);
      expect(w).toMatchObject({ code: 'DISCOUNT_CAPPED', requested: 5000000, discarded: 5000000 - w.applied });
      const inv = (await as('ketoan').get(`/invoices/${w.invoiceId}`).expect(200)).body;
      expect(inv.totalAmount).toBe(0);
      expect(g.body.warnings.every((x: any) => x.childId === k.id)).toBe(true);
    });
  });

  describe('child withdrawal (PM)', () => {
    const W1 = () => s.kids[12], W2 = () => s.kids[9];
    it('validations: future leave date 400; roles', async () => {
      expect((await as('admin').post(`/children/${s.kids[24].id}/withdraw`, { leaveDate: addDays(today, 1), reason: 'x' }).expect(400)).body.code).toBe('LEAVE_DATE_IN_FUTURE');
      await as('gv1').post(`/children/${s.kids[24].id}/withdraw`, { leaveDate: leave, reason: 'x' }).expect(403);
      await as('ph1').post(`/children/${s.kids[0].id}/withdraw`, { leaveDate: leave, reason: 'x' }).expect(403);
      expect((await as('admin').post(`/children/${s.kids[24].id}/withdraw`, { leaveDate: leave, reason: ' ' }).expect(400)).body.code).toBe('REASON_REQUIRED');
    });

    it('positive balance: future invoice voided (paid -> credit), pending meal refunds -> credit, payout voucher -> balance 0', async () => {
      const w = W1();
      for (const d of [addDays(today, -2), addDays(today, -3)])
        await as('admin').put(`/classes/${c1()}/attendance`, { date: d, items: [{ childId: w.id, status: 'absent', notifiedInAdvance: true }] }).expect(200);
      await as('ketoan').post('/invoices/generate', { period: next, classId: c1() }).expect(201);
      const nextInv = await invOf(w.id, next);
      expect(nextInv).toBeTruthy();
      await payAll(w.id); // family paid everything incl. next month
      expect(await credit(w.id)).toBe(0);

      const r = await as('ketoan').post(`/children/${w.id}/withdraw`, { leaveDate: leave, reason: 'Chuyển nhà' }).expect(200);
      expect(r.body).toMatchObject({ status: 'withdrawn', leaveDate: leave, outstandingDebt: 0, nextAction: 'refund_payout' });
      const moved = r.body.voidedInvoices.reduce((a: number, v: any) => a + v.movedToCredit, 0);
      expect(r.body.voidedInvoices.map((v: any) => v.id)).toContain(nextInv.id);
      expect(r.body.mealRefund.amount).toBe(40000 * r.body.mealRefund.days);
      // leave month: meals only for attended days -> the 2 notified absences are not charged
      expect(r.body.leaveMonth).toMatchObject({ period: leave.slice(0, 7), mealRate: 40000 });
      expect(r.body.creditBalance).toBe(moved + r.body.mealRefund.amount + r.body.leaveMonth.movedToCredit);
      const h = (await as('ketoan').get(`/invoices/${nextInv.id}/history`).expect(200)).body;
      expect(h.find((x: any) => x.action === 'voided').new.reason).toMatch(/nghỉ học/);

      // data kept, status withdrawn, excluded from lists / attendance / new invoices
      expect((await as('admin').get(`/children/${w.id}`).expect(200)).body).toMatchObject({ status: 'withdrawn', leaveDate: leave });
      expect((await as('admin').get(`/children?classId=${c1()}&limit=100`).expect(200)).body.items.map((c: any) => c.id)).not.toContain(w.id);
      expect((await as('admin').get('/children?status=withdrawn').expect(200)).body.items.map((c: any) => c.id)).toContain(w.id);
      expect((await as('gv1').put(`/classes/${c1()}/attendance`, { date: today, items: [{ childId: w.id, status: 'present' }] }).expect(400)).body.code).toBe('CHILD_WITHDRAWN');
      expect((await as('gv1').get(`/classes/${c1()}/attendance?date=${today}`).expect(200)).body.items.map((i: any) => i.childId)).not.toContain(w.id);
      expect((await as('gv1').get(`/classes/${c1()}/attendance?date=${leave}`).expect(200)).body.items.map((i: any) => i.childId)).toContain(w.id);
      await as('ketoan').post('/invoices/generate', { period: nextMonth(next), classId: c1() }).expect(201);
      expect(await invOf(w.id, nextMonth(next))).toBeUndefined();
      expect((await as('ketoan').post('/invoices', { childId: w.id, period: next, lines: [{ description: 'X', unitPrice: 1000 }] }).expect(409)).body.code).toBe('CHILD_WITHDRAWN');
      expect((await as('ketoan').post(`/children/${w.id}/prepayments`, { amount: 1000, method: 'cash' }).expect(409)).body.code).toBe('CHILD_WITHDRAWN');
      expect((await as('admin').post(`/children/${w.id}/withdraw`, { leaveDate: leave, reason: 'x' }).expect(409)).body.code).toBe('ALREADY_WITHDRAWN');

      // phiếu chi
      const bal = r.body.creditBalance;
      await as('gv1').post(`/children/${w.id}/refund-payouts`, { method: 'cash', recipientName: 'Mẹ bé' }).expect(403);
      const mis = await as('ketoan').post(`/children/${w.id}/refund-payouts`, { amount: bal - 1, method: 'cash', recipientName: 'Mẹ bé' }).expect(400);
      expect(mis.body).toMatchObject({ code: 'AMOUNT_MISMATCH', details: { creditBalance: bal } });
      const v = await as('ketoan').post(`/children/${w.id}/refund-payouts`, { method: 'transfer', recipientName: 'Mẹ bé' }).expect(201);
      expect(v.body).toMatchObject({ title: 'PHIẾU CHI', amount: bal, creditBalanceAfter: 0, recipientName: 'Mẹ bé', voucherNo: expect.stringMatching(/^PC\d{6}-\d{5}$/) });
      expect(v.body.amountInWords).toMatch(/đồng$/);
      expect((await as('ketoan').post(`/children/${w.id}/refund-payouts`, { method: 'cash', recipientName: 'Mẹ bé' }).expect(409)).body.code).toBe('NO_CREDIT_BALANCE');
      await as('ph1').get(`/refund-payouts/${v.body.payoutId}/voucher`).expect(403);
      const st = (await as('ketoan').get(`/children/${w.id}/withdrawal`).expect(200)).body;
      expect(st).toMatchObject({ status: 'withdrawn', creditBalance: 0, outstandingDebt: 0, nextAction: 'none' });
      expect(st.payouts).toHaveLength(1);
      expect((await as('ketoan').get(`/children/${w.id}/credits`).expect(200)).body.transactions[0]).toMatchObject({ type: 'payout', amount: -bal });
    });

    it('negative balance: refunds offset the debt, remainder stays in /debts until paid; no payout', async () => {
      const w = W2(); // unpaid last month; notified absence yesterday (seed)
      const b0 = (await as('ketoan').get(`/children/${w.id}/balance`).expect(200)).body;
      const debtBefore = b0.outstanding.filter((i: any) => i.period <= leave.slice(0, 7)).reduce((a: number, i: any) => a + i.balance, 0);
      expect(debtBefore).toBeGreaterThan(0);
      const r = await as('admin').post(`/children/${w.id}/withdraw`, { leaveDate: leave, reason: 'Gia đình chuyển trường' }).expect(200);
      const relief = r.body.mealRefund.amount + r.body.leaveMonth.mealAdjustment - r.body.mealClawback.amount;
      expect(relief).toBeGreaterThan(0);
      expect(r.body).toMatchObject({ outstandingDebt: debtBefore - relief, creditBalance: 0, nextAction: 'collect_debt' });
      const d = (await as('ketoan').get('/debts').expect(200)).body.items.find((x: any) => x.childId === w.id);
      expect(d).toMatchObject({ childStatus: 'withdrawn', leaveDate: leave, balance: r.body.outstandingDebt });
      expect((await as('ketoan').post(`/children/${w.id}/refund-payouts`, { method: 'cash', recipientName: 'Bố bé' }).expect(409)).body.code).toBe('NO_CREDIT_BALANCE');
      await payAll(w.id);
      expect((await as('ketoan').get('/debts').expect(200)).body.items.find((x: any) => x.childId === w.id)).toBeUndefined();
      expect((await as('ketoan').get(`/children/${w.id}/withdrawal`).expect(200)).body.nextAction).toBe('none');
    });
  });

  describe('leave month rule (PM): fixed fees full month, meals by attended days, accountant can edit', () => {
    const attended = async (childId: string) => Number((await ds.query(
      `SELECT COUNT(*)::int n FROM attendance WHERE child_id=$1 AND status IN ('present','late') AND date >= $2 AND date <= $3`, [childId, `${leave.slice(0, 7)}-01`, leave]))[0].n);
    const markDays = async (childId: string) => {
      for (const [d, st] of [[addDays(today, -4), 'present'], [addDays(today, -5), 'late'], [addDays(today, -6), 'absent']] as const)
        if (d.slice(0, 7) === leave.slice(0, 7))
          await as('admin').put(`/classes/${c1()}/attendance`, { date: d, items: [{ childId, status: st, notifiedInAdvance: st === 'absent' }] }).expect(200);
    };

    it('existing leave-month invoice: tuition unchanged, refund line for meal days not attended, editable by accountant', async () => {
      const k = s.kids[27]; // seed: notified absence yesterday, this month's invoice exists
      await markDays(k.id);
      const days = await attended(k.id);
      const lmInv = await invOf(k.id, leave.slice(0, 7));
      const before = (await as('ketoan').get(`/invoices/${lmInv.id}`).expect(200)).body;
      const r = await as('ketoan').post(`/children/${k.id}/withdraw`, { leaveDate: leave, reason: 'Về quê' }).expect(200);
      const mealDue = Math.min(900000, days * 40000);
      expect(r.body.leaveMonth).toMatchObject({ invoiceId: lmInv.id, created: false, attendedDays: days, mealCharged: 900000, mealAdjustment: 900000 - mealDue });
      const after = (await as('ketoan').get(`/invoices/${lmInv.id}`).expect(200)).body;
      const tuition = (x: any) => x.lines.filter((l: any) => l.description === 'Học phí');
      expect(tuition(after)).toEqual(tuition(before));
      expect(tuition(after)[0]).toMatchObject({ amount: 1500000 });
      const refund = after.lines.find((l: any) => l.kind === 'refund' && l.description.startsWith('Hoàn tiền ăn tháng nghỉ'));
      expect(refund).toMatchObject({ amount: -(900000 - mealDue), reason: expect.stringMatching(/Nghỉ học/) });
      expect(after.totalAmount).toBe(before.totalAmount - (900000 - mealDue));
      // accountant corrects it manually (e.g. one more day was eaten) -> audited
      const fixed = await as('ketoan').patch(`/invoices/${lmInv.id}/lines/${refund.id}`, { unitPrice: refund.unitPrice - 40000, reason: 'Bé ăn thêm 1 ngày' }).expect(200);
      expect(fixed.body.totalAmount).toBe(after.totalAmount + 40000);
      await as('gv1').patch(`/invoices/${lmInv.id}/lines/${refund.id}`, { unitPrice: 0 }).expect(403);
      const h = (await as('ketoan').get(`/invoices/${lmInv.id}/history`).expect(200)).body;
      expect(h.map((x: any) => x.action)).toEqual(expect.arrayContaining(['line_added', 'line_updated']));
    });

    it('no leave-month invoice yet: created with full tuition and meals × attended days', async () => {
      const k = s.kids[24];
      await markDays(k.id);
      const days = await attended(k.id);
      const lmInv = await invOf(k.id, leave.slice(0, 7));
      await as('ketoan').post(`/invoices/${lmInv.id}/void`, { reason: 'Lập lại khi nghỉ học' }).expect(200);
      const r = await as('admin').post(`/children/${k.id}/withdraw`, { leaveDate: leave, reason: 'Chuyển trường' }).expect(200);
      expect(r.body.leaveMonth).toMatchObject({ created: true, attendedDays: days, mealCharged: Math.min(900000, days * 40000) });
      const inv = (await as('ketoan').get(`/invoices/${r.body.leaveMonth.invoiceId}`).expect(200)).body;
      expect(inv.period).toBe(leave.slice(0, 7));
      expect(inv.lines.find((l: any) => l.description === 'Học phí')).toMatchObject({ amount: 1500000 });
      const meal = inv.lines.find((l: any) => l.kind === 'charge' && l.description.startsWith('Tiền ăn'));
      if (days > 0) expect(meal).toMatchObject({ amount: Math.min(900000, days * 40000), description: expect.stringMatching(/ngày đi học thực tế/) });
      else expect(meal).toBeUndefined();
    });
  });

  describe('reports: thu chi + Excel export', () => {
    const bin = (req: any) => req.buffer(true).parse((res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    it('finance has income/expense by month (payout counted as chi); low attendance flagged', async () => {
      const f = (await as('ketoan').get(`/reports/finance?fromMonth=${thisMonth}&toMonth=${thisMonth}`).expect(200)).body;
      const row = f.cashFlowByMonth.find((x: any) => x.month === thisMonth);
      expect(row.expense).toBeGreaterThan(0); // payout made in the withdrawal test
      expect(row.net).toBe(row.income - row.expense);
      const a = (await as('admin').get(`/reports/attendance?fromMonth=${thisMonth}`).expect(200)).body;
      expect(a.lowThreshold).toBe(80);
      for (const it of a.items) expect(it.low).toBe(it.attendanceRate !== null && it.attendanceRate < 80);
    });
    it('xlsx exports with the same permissions as the reports', async () => {
      for (const [who, url, code] of [['admin', '/reports/attendance/export', 200], ['admin', '/reports/enrollment/export', 200], ['ketoan', '/reports/finance/export', 200],
        ['admin', '/reports/finance/export', 200], ['ketoan', '/reports/attendance/export', 403], ['ketoan', '/reports/enrollment/export', 403], ['gv1', '/reports/finance/export', 403], ['ph1', '/reports/finance/export', 403]] as const) {
        const r = await bin(request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`)).expect(code);
        if (code === 200) {
          expect(r.headers['content-type']).toMatch(/spreadsheetml/);
          expect(r.headers['content-disposition']).toMatch(/attachment; filename=".+\.xlsx"/);
          expect(r.body.subarray(0, 2).toString()).toBe('PK');
          const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
          expect(wb.worksheets.length).toBeGreaterThan(0);
          expect(String(wb.worksheets[0].getCell(1, 1).value)).toMatch(/Báo cáo/);
        }
      }
      await request(http).get('/api/v1/reports/finance/export').expect(401);
    });
  });

  describe('account security', () => {
    it('mustChangePassword: admin-created and admin-reset accounts; cleared by change-password', async () => {
      const u = await as('admin').post('/users', { username: 'kt2', password: 'abc123', name: 'Kế toán 2', role: 'accountant' }).expect(201);
      expect(u.body.mustChangePassword).toBe(true);
      const l1 = await login('kt2', 'abc123').expect(200);
      expect(l1.body.user.mustChangePassword).toBe(true);
      const ch = await request(http).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${l1.body.accessToken}`)
        .send({ currentPassword: 'abc123', newPassword: 'moi12345' }).expect(200);
      expect(ch.body.user.mustChangePassword).toBe(false);
      expect((await login('kt2', 'moi12345').expect(200)).body.user.mustChangePassword).toBe(false);
      await as('admin').post(`/users/${u.body.id}/reset-password`, { newPassword: 'tam12345' }).expect(200);
      expect((await login('kt2', 'tam12345').expect(200)).body.user.mustChangePassword).toBe(true);
      expect((await login('ketoan').expect(200)).body.user.mustChangePassword).toBe(false); // seed accounts
      const tk = (await login('kt2', 'tam12345').expect(200)).body.accessToken;
      const me = await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${tk}`).expect(200);
      expect(me.body.mustChangePassword).toBe(true);
    });

    it('lockout 429 carries lockedUntil; admin list shows it; POST /users/:id/unlock', async () => {
      for (let i = 0; i < 5; i++) await login('gv2', 'sai-' + i).expect(401);
      const t0 = Date.now();
      const r = await login('gv2', '123456').expect(429);
      expect(r.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS', lockScope: 'account', retryAfterSeconds: expect.any(Number) });
      const until = new Date(r.body.lockedUntil).getTime();
      expect(r.body.lockedUntil).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(until).toBeGreaterThan(t0 + 14 * 60_000);
      const row = (await as('admin').get('/users?search=gv2').expect(200)).body.items.find((x: any) => x.username === 'gv2');
      expect(row).toMatchObject({ locked: true, lockedUntil: r.body.lockedUntil });
      await as('ketoan').post(`/users/${s.users.gv2.id}/unlock`).expect(403);
      const un = await as('admin').post(`/users/${s.users.gv2.id}/unlock`).expect(200);
      expect(un.body).toMatchObject({ wasLocked: true, locked: false, lockedUntil: null });
      await login('gv2', '123456').expect(200);
      expect((await as('admin').get(`/users/${s.users.gv2.id}`).expect(200)).body).toMatchObject({ locked: false, lockedUntil: null });
    });
  });
});
