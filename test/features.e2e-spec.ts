process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { pickupRequestExpiry } from '../src/attendance/attendance.controller';
import { addDays, todayStr } from '../src/common/dates';
import { parentReported } from './helpers/absence';
import { seed } from '../src/database/seed';

const nextMonth = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

describe('PM decisions, notifications, reports, users, rate limit (e2e)', () => {
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
    for (const u of ['admin', 'gv1', 'gv2', 'ketoan', 'ph1', 'ph2']) tokens[u] = (await login(u)).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });

  const todayAttendanceId = async (childIdx = 0) => {
    const r = await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: todayStr(), items: [{ childId: s.kids[childIdx].id, status: 'present' }] }).expect(200);
    return r.body.items.find((i: any) => i.childId === s.kids[childIdx].id).attendanceId as string;
  };
  const newRequest = async (attId: string, name = 'Chú Tư') =>
    (await as('gv1').post(`/attendance/${attId}/pickup-requests`, { pickerName: name, pickerPhone: '0909123456', note: 'Mẹ bé gọi báo' }).expect(201)).body;

  describe('pickup requests (PM)', () => {
    it('expiry = min(2h, end of day)', () => {
      const now = new Date();
      const exp = pickupRequestExpiry(now).getTime();
      expect(exp - now.getTime()).toBeLessThanOrEqual(2 * 3600_000);
      expect(exp).toBeLessThanOrEqual(new Date(`${addDays(todayStr(), 1)}T00:00:00+07:00`).getTime());
      const late = new Date(`${todayStr()}T23:00:00+07:00`);
      expect(pickupRequestExpiry(late).toISOString()).toBe(new Date(`${addDays(todayStr(), 1)}T00:00:00+07:00`).toISOString());
    });

    it('parent sees the request in the pickup feed (not the general inbox); expired request cannot be confirmed or used', async () => {
      const attId = await todayAttendanceId();
      const r = await newRequest(attId);
      expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const feed = await as('ph1').get('/pickup-requests/feed').expect(200);
      expect(feed.body.items.find((x: any) => x.id === r.id)).toMatchObject({ needsMyAction: true });
      const inbox = await as('ph1').get('/notifications').expect(200);
      expect(inbox.body.items.some((x: any) => x.type === 'pickup_request')).toBe(false);
      expect((await as('ph2').get('/pickup-requests/feed').expect(200)).body.items.some((x: any) => x.id === r.id)).toBe(false);
      await ds.query(`UPDATE pickup_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
      expect((await as('ph1').get('/pickup-requests?status=expired').expect(200)).body.map((x: any) => x.id)).toContain(r.id);
      expect((await as('ph1').post(`/pickup-requests/${r.id}/confirm`, {}).expect(409)).body.code).toBe('REQUEST_EXPIRED');
      expect((await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r.id }).expect(403)).body.code).toBe('PICKUP_REQUEST_EXPIRED');
    });

    it('approved but expired before hand-over -> 403', async () => {
      const attId = await todayAttendanceId();
      const r = await newRequest(attId, 'Cô Ba');
      await as('ph1').post(`/pickup-requests/${r.id}/confirm`, {}).expect(200);
      await ds.query(`UPDATE pickup_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
      expect((await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r.id }).expect(403)).body.code).toBe('PICKUP_REQUEST_EXPIRED');
    });

    it('admin may record the parent step on behalf only with a note (school step separate); teacher is notified', async () => {
      const attId = await todayAttendanceId();
      const r = await newRequest(attId, 'Bác Năm');
      expect((await as('admin').post(`/pickup-requests/${r.id}/parent-decision`, { decision: 'approve' }).expect(400)).body.code).toBe('VALIDATION_ERROR');
      const ok = await as('admin').post(`/pickup-requests/${r.id}/parent-decision`, { decision: 'approve', note: 'Đã gọi mẹ bé xác nhận qua điện thoại' }).expect(200);
      expect(ok.body).toMatchObject({ status: 'pending', decidedOnBehalf: true, decidedBy: s.users.admin.id, parent: { status: 'approved', channel: 'on_behalf' }, school: { status: 'pending' } });
      // school step by admin (no note needed to approve); hand-over by someone else (gv1)
      expect((await as('admin').post(`/pickup-requests/${r.id}/confirm`, {}).expect(200)).body).toMatchObject({ status: 'approved', school: { status: 'approved', role: 'admin' } });
      const tInbox = await as('gv1').get('/notifications').expect(200);
      expect(tInbox.body.items.some((x: any) => x.type === 'pickup_decision' && x.data.pickupRequestId === r.id)).toBe(true);
      await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r.id }).expect(201);
    });
  });

  describe('fees (PM)', () => {
    it('discount is a fee type with mandatory reason; negative prices rejected', async () => {
      await as('ketoan').post('/fee-items', { name: 'Giảm', amount: 100000, type: 'discount', scope: 'child', childId: s.kids[2].id }).expect(400);
      await as('ketoan').post('/fee-items', { name: 'Âm', amount: -1, type: 'monthly', scope: 'school' }).expect(400);
      await as('ketoan').post('/fee-items', { name: 'Giảm con GV', amount: 200000, type: 'discount', scope: 'child', childId: s.kids[2].id, reason: 'Con giáo viên' }).expect(201);
      const bad = await as('ketoan').post('/invoices', { childId: s.kids[2].id, period: '2027-05', lines: [{ description: 'X', unitPrice: -5 }] }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
      await as('ketoan').post('/invoices', { childId: s.kids[2].id, period: '2027-05', lines: [{ description: 'Đồng phục', unitPrice: 250000 }, { kind: 'discount', description: 'Giảm', unitPrice: 50000 }] }).expect(400);
    });

    it('generation: charges + discount + meal refund for notified absences + prepaid credit; accountant edits refund', async () => {
      const month = todayStr().slice(0, 7), period = nextMonth(month);
      // kids[9] (Mầm 1): seeded notified absence yesterday + 2 more notified, 1 not notified
      const d1 = `${month}-01`, d2 = `${month}-02`, d3 = `${month}-03`;
      await parentReported(ds, s.kids[9].id, [d1, d2]); // parent reports before cutoff → refundable; d3 teacher-only → not
      for (const [d, notified] of [[d1, true], [d2, true], [d3, false]] as const)
        await as('admin').put(`/classes/${s.classes.c1.id}/attendance`, { date: d, items: [{ childId: s.kids[9].id, status: 'absent', notifiedInAdvance: notified }] }).expect(200);
      const expectedDays = Number((await ds.query(`SELECT COUNT(*) n FROM attendance WHERE child_id=$1 AND status='absent' AND notified_in_advance AND to_char(date,'YYYY-MM')=$2`, [s.kids[9].id, month]))[0].n);
      expect(expectedDays).toBeGreaterThanOrEqual(2);
      const g = await as('ketoan').post('/invoices/generate', { period }).expect(201);
      expect(g.body.created).toBe(30);
      const get = async (idx: number) => {
        const i = (await as('ketoan').get(`/invoices?period=${period}&childId=${s.kids[idx].id}`).expect(200)).body.items[0];
        return (await as('ketoan').get(`/invoices/${i.id}`).expect(200)).body;
      };
      const k9 = await get(9);
      const refund = k9.lines.find((l: any) => l.kind === 'refund');
      expect(refund).toMatchObject({ quantity: expectedDays, unitPrice: 40000, amount: -40000 * expectedDays });
      expect(k9.totalAmount).toBe(1500000 + 900000 - 40000 * expectedDays);
      // accountant adjusts the refund
      const edited = await as('ketoan').patch(`/invoices/${k9.id}/lines/${refund.id}`, { quantity: 1, reason: 'Chỉ 1 ngày báo trước trước 8h' }).expect(200);
      expect(edited.body.totalAmount).toBe(1500000 + 900000 - 40000);
      await as('gv1').patch(`/invoices/${k9.id}/lines/${refund.id}`, { quantity: 2 }).expect(403);
      // sibling discount (seeded for kids[4])
      const k4 = await get(4);
      expect(k4.lines.find((l: any) => l.kind === 'discount')).toMatchObject({ unitPrice: 150000, amount: -150000, reason: expect.any(String) });
      expect(k4.lines.every((l: any) => l.unitPrice >= 0)).toBe(true);
      // seeded 500k prepayment for kids[7] applied as credit line
      const k7 = await get(7);
      expect(k7.lines.find((l: any) => l.kind === 'credit')).toMatchObject({ amount: -500000 });
      expect((await as('ketoan').get(`/children/${s.kids[7].id}/credits`).expect(200)).body.creditBalance).toBe(0);
      // parent got an invoice notification
      expect((await as('ph1').get('/notifications').expect(200)).body.items.some((x: any) => x.type === 'invoice' && x.data.period === period)).toBe(true);
    });

    it('refund lines never duplicate; edits are audited; corrected attendance is clawed back once (QA FEE-R04/R05/R06)', async () => {
      const month = todayStr().slice(0, 7), p1 = nextMonth(month), p2 = nextMonth(p1), p3 = nextMonth(p2), p4 = nextMonth(p3);
      const inv = async (period: string, idx = 9) => {
        const i = (await as('ketoan').get(`/invoices?period=${period}&childId=${s.kids[idx].id}`).expect(200)).body.items[0];
        return (await as('ketoan').get(`/invoices/${i.id}`).expect(200)).body;
      };
      expect((await as('ketoan').post('/invoices/generate', { period: p1 }).expect(201)).body).toMatchObject({ created: 0, skippedExisting: 30 });
      const first = await inv(p1);
      expect(first.lines.filter((l: any) => l.kind === 'refund')).toHaveLength(1);
      // audit trail of the accountant's edit in the previous test
      const h = await as('ketoan').get(`/invoices/${first.id}/history`).expect(200);
      expect(h.body[0]).toMatchObject({ action: 'line_updated', changedBy: s.users.ketoan.id, old: { quantity: expect.any(Number) }, new: { quantity: 1 } });
      await as('ph1').get(`/invoices/${first.id}/history`).expect(403);
      const refundLine = first.lines.find((l: any) => l.kind === 'refund');
      expect((await as('ketoan').del(`/invoices/${first.id}/lines/${refundLine.id}`).expect(409)).body.code).toBe('REFUND_LINE_USE_PATCH');
      // next month: the same absence days are not refunded again
      await as('ketoan').post('/invoices/generate', { period: p2, classId: s.classes.c1.id }).expect(201);
      expect((await inv(p2)).lines.some((l: any) => l.kind === 'refund')).toBe(false);
      // attendance corrected (absent-notified -> present) after the refund => one clawback line, only once
      await as('admin').put(`/classes/${s.classes.c1.id}/attendance`, { date: `${month}-01`, items: [{ childId: s.kids[9].id, status: 'present', overrideAbsence: true }] }).expect(200);
      await as('ketoan').post('/invoices/generate', { period: p3, classId: s.classes.c1.id }).expect(201);
      const claw = (await inv(p3)).lines.filter((l: any) => l.description.startsWith('Thu lại tiền ăn'));
      expect(claw).toHaveLength(1);
      expect(claw[0]).toMatchObject({ kind: 'charge', amount: 40000 });
      await as('ketoan').post('/invoices/generate', { period: p4, classId: s.classes.c1.id }).expect(201);
      expect((await inv(p4)).lines.some((l: any) => l.description.startsWith('Thu lại tiền ăn'))).toBe(false);
    });

    it('amount in words and overdue cutoff (00:01 VN on the 11th)', async () => {
      const { vndInWords } = await import('../src/common/money');
      const { overdueCutoff } = await import('../src/common/dates');
      expect(vndInWords(0)).toBe('Không đồng');
      expect(vndInWords(1000005)).toBe('Một triệu không trăm linh năm đồng');
      expect(vndInWords(2150000)).toBe('Hai triệu một trăm năm mươi nghìn đồng');
      expect(vndInWords(1000000000)).toBe('Một tỷ đồng');
      expect(overdueCutoff(new Date('2026-10-10T17:00:59Z'))).toBe('2026-10-10'); // 11/10 00:00:59 VN: due 10/10 not overdue yet
      expect(overdueCutoff(new Date('2026-10-10T17:01:00Z'))).toBe('2026-10-11'); // 11/10 00:01 VN: due 10/10 overdue
      expect(overdueCutoff(new Date('2026-10-10T16:59:00Z'))).toBe('2026-10-10'); // 10/10 23:59 VN
    });

    it('prepayment creates credit; voiding restores applied credit', async () => {
      const r = await as('ketoan').post(`/children/${s.kids[2].id}/prepayments`, { amount: 300000, method: 'cash' }).expect(201);
      expect(r.body).toMatchObject({ kind: 'prepayment', creditAdded: 300000, invoice: null, amountInWords: 'Ba trăm nghìn đồng' });
      await as('ph1').get(`/payments/${r.body.paymentId}/receipt`).expect(403);
      await as('gv1').post(`/children/${s.kids[2].id}/prepayments`, { amount: 1, method: 'cash' }).expect(403);
      const inv = await as('ketoan').post('/invoices', { childId: s.kids[2].id, period: '2027-06', lines: [{ description: 'Đồng phục', unitPrice: 250000 }] }).expect(201);
      expect(inv.body).toMatchObject({ totalAmount: 0, status: 'paid' });
      expect((await as('ketoan').get(`/children/${s.kids[2].id}/credits`).expect(200)).body.creditBalance).toBe(50000);
      await as('ketoan').post(`/invoices/${inv.body.id}/void`, { reason: 'Lập nhầm' }).expect(200);
      expect((await as('ketoan').get(`/children/${s.kids[2].id}/credits`).expect(200)).body.creditBalance).toBe(300000);
    });

    it('debts list marks overdue (past the 10th)', async () => {
      const d = await as('ketoan').get('/debts').expect(200);
      expect(d.body.dueDay).toBe(10);
      const today = todayStr();
      for (const it of d.body.items) expect(it.overdue).toBe(it.oldestDueDate < today);
      const o = await as('ketoan').get('/debts?overdueOnly=true').expect(200);
      expect(o.body.items.every((x: any) => x.overdue && x.overdueAmount > 0)).toBe(true);
      expect(o.body.totalOverdue).toBe(d.body.totalOverdue);
    });
  });

  describe('menu allergy notes (PM)', () => {
    it('allergy substitution notes + allergy alerts scoped to viewer', async () => {
      const t = await as('gv1').get('/menus').expect(200);
      expect(t.body.days[0].allergyNotes.lunch).toMatch(/Dị ứng/);
      expect(t.body.allergyAlerts.length).toBeGreaterThan(0);
      expect(t.body.allergyAlerts.every((a: any) => a.className === 'Mầm 1')).toBe(true);
      const p = await as('ph1').get('/menus').expect(200);
      expect(p.body.allergyAlerts.map((a: any) => a.childId)).toEqual([s.kids[0].id]);
      const put = await as('admin').put('/menus', { weekStart: t.body.weekStart, items: [{ date: t.body.weekStart, meal: 'snack', dishes: 'Bánh trứng', allergyNotes: 'Dị ứng trứng: thay bằng chuối' }] }).expect(200);
      expect(put.body.days[0].allergyNotes.snack).toBe('Dị ứng trứng: thay bằng chuối');
    });
  });

  describe('announcements & inbox', () => {
    it('teacher: own class only; admin: school; recipients scoped; read status', async () => {
      await as('gv1').post('/announcements', { title: 'X', body: 'Y', scope: 'school' }).expect(403);
      await as('gv1').post('/announcements', { title: 'X', body: 'Y', scope: 'class', classId: s.classes.c2.id }).expect(403);
      await as('ph1').post('/announcements', { title: 'X', body: 'Y', scope: 'school' }).expect(403);
      const c = await as('gv1').post('/announcements', { title: 'Dã ngoại', body: 'Thứ 6 lớp đi dã ngoại', scope: 'class', classId: s.classes.c1.id, audience: 'parents' }).expect(201);
      expect(c.body.recipientCount).toBe(1); // only ph1 has a child in Mầm 1
      const a = await as('admin').post('/announcements', { title: 'Nghỉ lễ', body: 'Nghỉ 20/11', scope: 'school' }).expect(201);
      expect(a.body.recipientCount).toBe(6);
      expect((await as('ph2').get('/announcements').expect(200)).body.items.map((x: any) => x.id)).not.toContain(c.body.id);
      expect((await as('ph1').get('/announcements').expect(200)).body.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([a.body.id, c.body.id]));
      expect((await as('ketoan').get('/announcements').expect(200)).body.items.every((x: any) => x.scope === 'school')).toBe(true);

      const inbox = await as('ph1').get('/notifications').expect(200);
      const n = inbox.body.items.find((x: any) => x.announcementId === a.body.id);
      expect(n.read).toBe(false);
      const before = (await as('ph1').get('/notifications/unread-count').expect(200)).body.unreadCount;
      await as('ph1').post(`/notifications/${n.id}/read`).expect(200);
      expect((await as('ph1').get('/notifications/unread-count').expect(200)).body.unreadCount).toBe(before - 1);
      await as('ph2').post(`/notifications/${n.id}/read`).expect(404); // someone else's item
      await as('ph1').post('/notifications/read-all').expect(200);
      expect((await as('ph1').get('/notifications/unread-count').expect(200)).body.unreadCount).toBe(0);
      await as('gv2').del(`/announcements/${c.body.id}`).expect(403);
      await as('gv1').del(`/announcements/${c.body.id}`).expect(204);
    });
  });

  describe('reports', () => {
    it('attendance & enrollment admin only; finance admin + accountant', async () => {
      const month = todayStr().slice(0, 7);
      const att = await as('admin').get(`/reports/attendance?fromMonth=${month}&toMonth=${month}`).expect(200);
      expect(att.body.items.length).toBeGreaterThan(0);
      expect(att.body.items[0]).toMatchObject({ classId: expect.any(String), month, attendanceRate: expect.any(Number) });
      await as('ketoan').get('/reports/attendance').expect(403);
      await as('gv1').get('/reports/attendance').expect(403);
      const en = await as('admin').get('/reports/enrollment').expect(200);
      expect(en.body.totals.active).toBe(30);
      expect(en.body.byClass).toHaveLength(3);
      await as('ketoan').get('/reports/enrollment').expect(403);
      const fin = await as('ketoan').get(`/reports/finance?fromMonth=${s.periods.lastMonth}&toMonth=${month}`).expect(200);
      const last = fin.body.byPeriod.find((x: any) => x.month === s.periods.lastMonth);
      expect(last.invoiced).toBeGreaterThan(0);
      expect(last.invoiced).toBe(last.collected + last.outstanding);
      expect(fin.body.current.totalDebt).toBeGreaterThan(0);
      await as('admin').get('/reports/finance').expect(200);
      await as('gv1').get('/reports/finance').expect(403);
      await as('ph1').get('/reports/finance').expect(403);
      await as('admin').get('/reports/finance?fromMonth=2026-10&toMonth=2026-01').expect(400);
    });
  });

  describe('user management', () => {
    it('admin CRUD, reset password, deactivate; non-admin 403; no hash leak', async () => {
      await as('gv1').get('/users').expect(403);
      await as('ketoan').post('/users', { username: 'x1', password: '123456', name: 'X', role: 'admin' }).expect(403);
      const list = await as('admin').get('/users?role=teacher').expect(200);
      expect(list.body.total).toBe(3);
      expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|password_hash|"password"|\$2[aby]\$/i);
      const u = await as('admin').post('/users', { username: 'gv4', password: 'abc123', name: 'Cô Thảo', role: 'teacher' }).expect(201);
      await as('admin').post('/users', { username: 'gv4', password: 'abc123', name: 'X', role: 'teacher' }).expect(409);
      const t1 = (await login('gv4', 'abc123').expect(200)).body.accessToken;
      await as('admin').post(`/users/${u.body.id}/reset-password`, { newPassword: 'newpass1' }).expect(200);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${t1}`).expect(401); // old sessions revoked
      await login('gv4', 'abc123').expect(401);
      await login('gv4', 'newpass1').expect(200);
      await as('admin').post(`/users/${u.body.id}/deactivate`).expect(200);
      await login('gv4', 'newpass1').expect(401);
      await as('admin').post(`/users/${u.body.id}/activate`).expect(200);
      await login('gv4', 'newpass1').expect(200);
      await as('admin').patch(`/users/${u.body.id}`, { name: 'Cô Thảo Nguyên', role: 'accountant' }).expect(200);
      await as('admin').del(`/users/${u.body.id}`).expect(204);
      expect((await as('admin').del(`/users/${s.users.gv1.id}`).expect(409)).body.code).toBe('USER_HAS_HISTORY');
      expect((await as('admin').patch(`/users/${s.users.gv1.id}`, { role: 'accountant' }).expect(409)).body.code).toBe('USER_HAS_LINKS');
      expect((await as('admin').post(`/users/${s.users.admin.id}/deactivate`).expect(400)).body.code).toBe('SELF_CHANGE');
    });

    it('change own password: wrong current 400, then old sessions revoked', async () => {
      const old = tokens.ph2;
      expect((await as('ph2').post('/auth/change-password', { currentPassword: 'sai', newPassword: 'matkhau2' }).expect(400)).body.code).toBe('WRONG_PASSWORD');
      await as('ph2').post('/auth/change-password', { currentPassword: '123456', newPassword: '123' }).expect(400);
      const r = await as('ph2').post('/auth/change-password', { currentPassword: '123456', newPassword: 'matkhau2' }).expect(200);
      expect(r.body.accessToken).toEqual(expect.any(String));
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${old}`).expect(401);
      await request(http).get('/api/v1/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`).expect(200);
      await login('ph2', 'matkhau2').expect(200);
    });
  });

  describe('login rate limit', () => {
    it('5 failures -> locked (429 + Retry-After) even with correct password; admin reset unlocks', async () => {
      for (let i = 0; i < 5; i++) await login('gv3', 'sai-' + i).expect(401);
      const locked = await login('gv3', '123456').expect(429);
      expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      await login('gv2', '123456').expect(200); // other accounts unaffected
      await as('admin').post(`/users/${s.users.gv3.id}/reset-password`, { newPassword: 'reset123' }).expect(200);
      await login('gv3', 'reset123').expect(200);
    });
    it('a successful login resets the failure counter', async () => {
      for (let i = 0; i < 4; i++) await login('gv2', 'x').expect(401);
      await login('gv2', '123456').expect(200);
      for (let i = 0; i < 4; i++) await login('gv2', 'x').expect(401);
      await login('gv2', '123456').expect(200);
    });
  });
});
