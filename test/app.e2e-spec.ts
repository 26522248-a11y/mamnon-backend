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

describe('Mầm non API (e2e)', () => {
  let app: NestExpressApplication;
  let http: any;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};

  const login = (username: string, password = '123456') =>
    request(http).post('/api/v1/auth/login').send({ username, password });
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    const ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'ketoan', 'ph1', 'ph2']) tokens[u] = (await login(u)).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });

  describe('auth', () => {
    it('login OK: access token in body, refresh token in httpOnly cookie', async () => {
      const r = await login('gv1').expect(200);
      expect(r.body.accessToken).toEqual(expect.any(String));
      expect(r.body.user).toMatchObject({ username: 'gv1', role: 'teacher', classIds: [s.classes.c1.id] });
      const cookie = ([] as string[]).concat(r.headers['set-cookie'] as any).find((c) => c.startsWith('refresh_token='))!;
      expect(cookie).toMatch(/HttpOnly/);
      const rr = await request(http).post('/api/v1/auth/refresh').set('Cookie', cookie.split(';')[0]).expect(200);
      expect(rr.body.accessToken).toEqual(expect.any(String));
    });
    it('wrong password -> 401 {code,message}', async () => {
      const r = await login('admin', 'sai').expect(401);
      expect(r.body).toEqual({ code: 'INVALID_CREDENTIALS', message: expect.any(String) });
    });
    it('no token -> 401; /auth/me with token -> user', async () => {
      const r = await request(http).get('/api/v1/auth/me').expect(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
      const me = await as('ph1').get('/auth/me').expect(200);
      expect(me.body).toMatchObject({ role: 'parent', childIds: [s.kids[0].id] });
    });
    it('refresh without cookie -> 401', async () => {
      expect((await request(http).post('/api/v1/auth/refresh').expect(401)).body.code).toBe('NO_REFRESH_TOKEN');
    });
  });

  describe('authorization (403)', () => {
    it('teacher reading attendance of another class -> 403', async () => {
      const r = await as('gv1').get(`/classes/${s.classes.c2.id}/attendance`).expect(403);
      expect(r.body).toEqual({ code: 'FORBIDDEN', message: expect.any(String) });
      await as('gv1').get(`/classes/${s.classes.c1.id}/attendance`).expect(200);
    });
    it('teacher reading a child of another class -> 403', async () => {
      await as('gv1').get(`/children/${s.kids[1].id}`).expect(403);
    });
    it('teacher cannot create classes -> 403', async () => {
      await as('gv1').post('/classes', { name: 'X', ageGroup: '3-4 tuổi' }).expect(403);
    });
    it('parent changing child id in URL -> 403; own child -> 200', async () => {
      await as('ph1').get(`/children/${s.kids[1].id}`).expect(403);
      await as('ph1').get(`/children/${s.kids[1].id}/guardians`).expect(403);
      await as('ph1').get(`/children/${s.kids[0].id}`).expect(200);
      const list = await as('ph1').get('/children').expect(200);
      expect(list.body.total).toBe(1);
    });
    it('accountant: basic child info only, no attendance / guardians', async () => {
      const r = await as('ketoan').get('/children?limit=5').expect(200);
      expect(r.body.total).toBe(30);
      expect(Object.keys(r.body.items[0]).sort()).toEqual(['classId', 'className', 'fullName', 'id', 'status']);
      await as('ketoan').get(`/classes/${s.classes.c1.id}/attendance`).expect(403);
      await as('ketoan').get(`/children/${s.kids[0].id}/guardians`).expect(403);
    });
  });

  describe('children & attendance', () => {
    it('pagination + class filter + accent-insensitive search', async () => {
      const r = await as('admin').get(`/children?page=2&limit=4&classId=${s.classes.c1.id}`).expect(200);
      expect(r.body).toMatchObject({ page: 2, limit: 4, total: 10 });
      expect(r.body.items).toHaveLength(4);
      const q = await as('admin').get('/children?search=binh').expect(200);
      expect(q.body.items.every((c: any) => c.fullName.includes('Bình'))).toBe(true);
      expect(q.body.total).toBeGreaterThan(0);
    });
    it('teacher edits attendance within 3 days, older -> 403, admin can', async () => {
      const kid = s.kids[0];
      const today = await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: todayStr(), items: [{ childId: kid.id, status: 'present' }] }).expect(200);
      expect(today.body.items.find((i: any) => i.childId === kid.id).status).toBe('present');
      await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: addDays(todayStr(), -3), items: [{ childId: kid.id, status: 'late' }] }).expect(200);
      const old = await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: addDays(todayStr(), -4), items: [{ childId: kid.id, status: 'late' }] }).expect(403);
      expect(old.body.code).toBe('EDIT_WINDOW_EXPIRED');
      await as('admin').put(`/classes/${s.classes.c1.id}/attendance`, { date: addDays(todayStr(), -10), items: [{ childId: kid.id, status: 'absent' }] }).expect(200);
      await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: todayStr(), items: [{ childId: s.kids[1].id, status: 'present' }] }).expect(400);
    });
    it('attendance edits are audited: who, when, old -> new; history only for admin/own-class teacher', async () => {
      const kid = s.kids[0], c1 = s.classes.c1.id, d = addDays(todayStr(), -2);
      await as('gv1').put(`/classes/${c1}/attendance`, { date: d, items: [{ childId: kid.id, status: 'present' }] }).expect(200);
      await as('gv1').put(`/classes/${c1}/attendance`, { date: d, items: [{ childId: kid.id, status: 'present' }] }).expect(200); // no change -> no entry
      const sheet = await as('admin').put(`/classes/${c1}/attendance`, { date: d, items: [{ childId: kid.id, status: 'absent', note: 'Ốm' }] }).expect(200);
      const attId = sheet.body.items.find((i: any) => i.childId === kid.id).attendanceId;
      const h = await as('gv1').get(`/attendance/${attId}/history`).expect(200);
      expect(h.body.items).toHaveLength(2);
      expect(h.body.items[0]).toMatchObject({ action: 'create', old: null, new: { status: 'present' }, changedBy: s.users.gv1.id });
      expect(h.body.items[1]).toMatchObject({ action: 'update', old: { status: 'present', note: null }, new: { status: 'absent', note: 'Ốm' }, changedBy: s.users.admin.id, changedByName: 'Cô Hiệu trưởng' });
      expect(h.body.items[1].changedAt).toEqual(expect.any(String));
      // other-class attendance -> 403 for gv1; parent/accountant -> 403
      const other = await as('admin').get(`/classes/${s.classes.c2.id}/attendance?date=${addDays(todayStr(), -1)}`).expect(200);
      await as('gv1').get(`/attendance/${other.body.items[0].attendanceId}/history`).expect(403);
      await as('ph1').get(`/attendance/${attId}/history`).expect(403);
      await as('ketoan').get(`/attendance/${attId}/history`).expect(403);
    });

    it('pickup by listed guardian OK; canPickup=false -> 403; unlisted person needs a confirmed request', async () => {
      const today = await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: todayStr(), items: [{ childId: s.kids[0].id, status: 'present' }] }).expect(200);
      const attId = today.body.items.find((i: any) => i.childId === s.kids[0].id).attendanceId;
      const gs = (await as('admin').get(`/children/${s.kids[0].id}/guardians`).expect(200)).body;
      const dad = gs.find((g: any) => g.relation === 'Bố'), grandma = gs.find((g: any) => !g.canPickup);
      const ok = await as('gv1').post(`/attendance/${attId}/pickup`, { guardianId: dad.id }).expect(201);
      expect(ok.body).toMatchObject({ isAuthorized: true, pickedUpByName: dad.fullName });
      expect((await as('gv1').post(`/attendance/${attId}/pickup`, { guardianId: grandma.id }).expect(403)).body.code).toBe('PICKUP_NOT_ALLOWED');
      await as('gv1').post(`/attendance/${attId}/pickup`, {}).expect(400);
    });

    it('pickup request flow: pending -> 403, parent confirms -> release; rejected -> 403; other parent cannot decide', async () => {
      const today = await as('gv1').get(`/classes/${s.classes.c1.id}/attendance?date=${todayStr()}`).expect(200);
      const attId = today.body.items.find((i: any) => i.childId === s.kids[0].id).attendanceId;
      // create with photo (multipart)
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const r1 = await request(http).post(`/api/v1/attendance/${attId}/pickup-requests`).set('Authorization', `Bearer ${tokens.gv1}`)
        .field('pickerName', 'Chú Tư').field('pickerPhone', '0909123456').field('note', 'Mẹ bé gọi báo').attach('photo', png, { filename: 'a.png', contentType: 'image/png' })
        .expect(201);
      expect(r1.body).toMatchObject({ status: 'pending', photoUrl: `/api/v1/pickup-requests/${r1.body.id}/photo` });
      await request(http).get(r1.body.photoUrl).expect(401);
      const ph = await request(http).get(r1.body.photoUrl).set('Authorization', `Bearer ${tokens.ph1}`).expect(200);
      expect(ph.headers['content-type']).toBe('image/png');
      expect((await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r1.body.id }).expect(403)).body.code).toBe('PICKUP_REQUEST_PENDING');
      // parent sees pending request for own child; other parent does not, and cannot confirm
      const mine = await as('ph1').get('/pickup-requests?status=pending').expect(200);
      expect(mine.body.map((x: any) => x.id)).toContain(r1.body.id);
      tokens.ph2 = (await login('ph2')).body.accessToken;
      expect((await as('ph2').get('/pickup-requests?status=pending').expect(200)).body).toHaveLength(0);
      await as('ph2').post(`/pickup-requests/${r1.body.id}/confirm`, {}).expect(403);
      await request(http).get(r1.body.photoUrl).set('Authorization', `Bearer ${tokens.ph2}`).expect(403);
      await as('gv1').post(`/pickup-requests/${r1.body.id}/confirm`, {}).expect(403);
      await as('ketoan').get('/pickup-requests').expect(403);
      // parent confirms -> teacher can release
      expect((await as('ph1').post(`/pickup-requests/${r1.body.id}/confirm`, { note: 'Đúng chú bé' }).expect(200)).body.status).toBe('approved');
      await as('ph1').post(`/pickup-requests/${r1.body.id}/reject`, {}).expect(409);
      const rel = await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r1.body.id }).expect(201);
      expect(rel.body).toMatchObject({ pickedUpByName: 'Chú Tư', pickupRequestId: r1.body.id, isAuthorized: true });
      // a second request, rejected by admin -> 403 on release
      const r2 = await as('gv1').post(`/attendance/${attId}/pickup-requests`, { pickerName: 'Người lạ', pickerPhone: '0909000111', note: 'Không rõ' }).expect(201);
      await as('admin').post(`/pickup-requests/${r2.body.id}/reject`, { note: 'Phụ huynh không biết người này' }).expect(200);
      expect((await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r2.body.id }).expect(403)).body.code).toBe('PICKUP_REQUEST_REJECTED');
    });

    it('monthly attendance summary: accountant sees day counts only, no detail', async () => {
      const month = addDays(todayStr(), -1).slice(0, 7);
      const r = await as('ketoan').get(`/children/attendance-summary?month=${month}&classId=${s.classes.c2.id}`).expect(200);
      expect(r.body.total).toBe(10);
      const row = r.body.items[0];
      expect(Object.keys(row).sort()).toEqual(['absentDays', 'attendedDays', 'childId', 'className', 'classId', 'fullName', 'lateDays', 'presentDays', 'recordedDays'].sort());
      expect(r.body.items.reduce((n: number, x: any) => n + x.recordedDays, 0)).toBeGreaterThan(0);
      await as('ketoan').get('/children/attendance-summary?month=2026-13').expect(400);
      const p = await as('ph1').get(`/children/attendance-summary?month=${month}`).expect(200);
      expect(p.body.total).toBe(1);
      await as('ketoan').get(`/children/${s.kids[0].id}/attendance`).expect(403);
    });
  });

  describe('photos (P0)', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const upload = (who: string, childId: string, buf: Buffer, name: string, type: string) =>
      request(http).post(`/api/v1/children/${childId}/photo`).set('Authorization', `Bearer ${tokens[who]}`).attach('file', buf, { filename: name, contentType: type });

    it('rejects non-image content even with image name/type (magic bytes)', async () => {
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
      expect((await upload('admin', s.kids[0].id, exe, 'x.jpg', 'image/jpeg').expect(400)).body.code).toBe('INVALID_FILE');
      await upload('admin', s.kids[0].id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.png', 'image/png').expect(400);
      await upload('admin', s.kids[0].id, Buffer.from('GIF89a......'), 'x.gif', 'image/gif').expect(400);
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
      await upload('gv1', s.kids[0].id, jpg, 'renamed.bin', 'application/octet-stream').expect(201); // real JPEG, odd name OK
      await upload('gv1', s.kids[1].id, png, 'a.png', 'image/png').expect(403);
    });

    it('photo served only via authenticated, permission-checked endpoint', async () => {
      const r = await upload('gv1', s.kids[0].id, png, 'a.png', 'image/png').expect(201);
      const url = r.body.photoUrl;
      expect(url).toBe(`/api/v1/children/${s.kids[0].id}/photo`);
      expect((await as('ph1').get(`/children/${s.kids[0].id}`).expect(200)).body.photoUrl).toBe(url);
      await request(http).get(url).expect(401);
      const ok = await request(http).get(url).set('Authorization', `Bearer ${tokens.ph1}`).expect(200);
      expect(ok.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(ok.body, png)).toBe(0);
      await request(http).get(url).set('Authorization', `Bearer ${tokens.gv1}`).expect(200);
      await request(http).get(url).set('Authorization', `Bearer ${tokens.admin}`).expect(200);
      await request(http).get(url).set('Authorization', `Bearer ${tokens.ph2}`).expect(403);
      await request(http).get(url).set('Authorization', `Bearer ${tokens.ketoan}`).expect(403);
      const gv2 = (await login('gv2')).body.accessToken;
      await request(http).get(url).set('Authorization', `Bearer ${gv2}`).expect(403);
      // no public static serving of the storage dir
      const files = require('fs').readdirSync(process.env.UPLOAD_DIR!);
      expect(files.length).toBeGreaterThan(0);
      const st = await request(http).get(`/uploads/${files[0]}`);
      expect([401, 404]).toContain(st.status);
      await as('ph2').get(`/children/${s.kids[1].id}/photo`).expect(404); // no photo yet
    });
  });

  describe('dashboard', () => {
    it('summary scoped by role', async () => {
      const d = addDays(todayStr(), -1);
      const a = await as('admin').get(`/dashboard/summary?date=${d}`).expect(200);
      expect(a.body).toMatchObject({ scope: 'school', totalChildren: 30 });
      expect(a.body.present + a.body.late + a.body.absent + a.body.unmarked).toBe(30);
      expect(a.body.byClass).toHaveLength(3);
      const t = await as('gv1').get(`/dashboard/summary?date=${d}`).expect(200);
      expect(t.body).toMatchObject({ scope: 'own_classes', totalChildren: 10 });
      expect(t.body.byClass.map((c: any) => c.classId)).toEqual([s.classes.c1.id]);
      const k = await as('ketoan').get(`/dashboard/summary?date=${d}`).expect(200);
      expect(k.body.totalChildren).toBe(30);
      expect(k.body.byClass).toBeUndefined();
      const p = await as('ph1').get(`/dashboard/summary?date=${d}`).expect(200);
      expect(p.body).toMatchObject({ scope: 'own_children', totalChildren: 1 });
      expect(p.body.children[0].childId).toBe(s.kids[0].id);
    });
  });

  describe('fees', () => {
    it('fee items: admin/accountant manage; teacher & parent 403; scope validated', async () => {
      await as('gv1').get('/fee-items').expect(403);
      await as('ph1').get('/fee-items').expect(403);
      await as('gv1').post('/fee-items', { name: 'X', amount: 1, type: 'monthly', scope: 'school' }).expect(403);
      await as('ketoan').post('/fee-items', { name: 'X', amount: 1000, type: 'monthly', scope: 'class' }).expect(400);
      const it = await as('ketoan').post('/fee-items', { name: 'Bơi', amount: 400000, type: 'monthly', scope: 'class', classId: s.classes.c2.id }).expect(201);
      expect((await as('admin').get('/fee-items').expect(200)).body.map((x: any) => x.id)).toContain(it.body.id);
    });

    it('generate monthly invoices with class/child items, skip existing', async () => {
      const g = await as('ketoan').post('/invoices/generate', { period: '2027-03', dueDate: '2027-03-10' }).expect(201);
      expect(g.body.created).toBe(30);
      expect((await as('ketoan').post('/invoices/generate', { period: '2027-03' }).expect(201)).body).toMatchObject({ created: 0, skippedExisting: 30 });
      const an = (await as('ketoan').get(`/invoices?period=2027-03&childId=${s.kids[0].id}`).expect(200)).body.items[0];
      expect(an.totalAmount).toBe(1500000 + 900000 + 200000); // school fees + child-specific "Năng khiếu vẽ"
      const c2kid = (await as('ketoan').get(`/invoices?period=2027-03&childId=${s.kids[1].id}`).expect(200)).body.items[0];
      expect(c2kid.totalAmount).toBe(1500000 + 900000 + 400000); // + class item "Bơi"
      expect(an.invoiceNo).toMatch(/^HD202703-\d{5}$/);
    });

    it('payments: partial -> paid, overpayment becomes credit, receipt with amount in words; debt balance', async () => {
      const inv = (await as('ketoan').get(`/invoices?period=2027-03&childId=${s.kids[0].id}`).expect(200)).body.items[0];
      await as('gv1').post(`/invoices/${inv.id}/payments`, { amount: 1000, method: 'cash' }).expect(403);
      await as('ph1').post(`/invoices/${inv.id}/payments`, { amount: 1000, method: 'cash' }).expect(403);
      const p1 = await as('ketoan').post(`/invoices/${inv.id}/payments`, { amount: 1000000, method: 'cash', payerName: 'Nguyễn Văn Hùng' }).expect(201);
      expect(p1.body).toMatchObject({ amount: 1000000, amountInWords: 'Một triệu đồng', invoice: { status: 'partial', balanceAfter: 1600000 } });
      expect(p1.body.receiptNo).toMatch(/^PT202703-\d{5}$/);
      const p2 = await as('admin').post(`/invoices/${inv.id}/payments`, { amount: 1700000, method: 'transfer' }).expect(201);
      expect(p2.body).toMatchObject({ appliedToInvoice: 1600000, creditAdded: 100000, currentCreditBalance: 100000, invoice: { status: 'paid' } });
      expect((await as('ketoan').post(`/invoices/${inv.id}/payments`, { amount: 1, method: 'cash' }).expect(409)).body.code).toBe('ALREADY_PAID');
      expect((await as('ph1').get(`/children/${s.kids[0].id}/credits`).expect(200)).body.creditBalance).toBe(100000);
      const detail = await as('ph1').get(`/invoices/${inv.id}`).expect(200);
      expect(detail.body.payments).toHaveLength(2);
      expect(detail.body.lines.length).toBe(3);
      await as('ph1').get(`/payments/${p1.body.paymentId}/receipt`).expect(200);
      const bal = await as('ph1').get(`/children/${s.kids[0].id}/balance`).expect(200);
      expect(bal.body).toMatchObject({ childId: s.kids[0].id, balance: 0, creditBalance: 100000, netBalance: -100000 });
      const debts = await as('ketoan').get('/debts').expect(200);
      expect(debts.body.totalDebt).toBeGreaterThan(0);
      expect(debts.body.items.find((x: any) => x.childId === s.kids[0].id)).toBeUndefined();
      await as('gv1').get('/debts').expect(403);
    });

    it('parent sees only own child invoices/receipts/balance (403 otherwise)', async () => {
      const mine = await as('ph1').get('/invoices').expect(200);
      expect(mine.body.total).toBeGreaterThan(0);
      expect(mine.body.items.every((i: any) => i.childId === s.kids[0].id)).toBe(true);
      const other = (await as('ketoan').get(`/invoices?childId=${s.kids[1].id}`).expect(200)).body.items[0];
      await as('ph1').get(`/invoices/${other.id}`).expect(403);
      await as('ph1').get(`/children/${s.kids[1].id}/balance`).expect(403);
      const otherPaid = (await as('ketoan').get(`/invoices?status=paid&childId=${s.kids[3].id}`).expect(200)).body.items[0];
      const pay = (await as('ketoan').get(`/invoices/${otherPaid.id}`).expect(200)).body.payments[0];
      await as('ph1').get(`/payments/${pay.id}/receipt`).expect(403);
      await as('gv1').get('/invoices').expect(403);
      await as('gv1').get(`/children/${s.kids[0].id}/balance`).expect(403);
    });

    it('void: only without payments; frees the period for a corrected invoice', async () => {
      const inv = (await as('ketoan').get(`/invoices?period=2027-03&childId=${s.kids[1].id}`).expect(200)).body.items[0];
      await as('ketoan').post(`/invoices/${inv.id}/void`, { reason: 'Lập nhầm' }).expect(200);
      const fixed = await as('ketoan').post('/invoices', { childId: s.kids[1].id, period: '2027-03', lines: [{ feeItemId: s.fees.tuition.id }, { kind: 'discount', description: 'Giảm trừ', unitPrice: 100000, reason: 'Hoàn cảnh khó khăn' }] }).expect(201);
      expect(fixed.body.totalAmount).toBe(1400000);
      await as('ketoan').post('/invoices', { childId: s.kids[1].id, period: '2027-03', lines: [{ feeItemId: s.fees.tuition.id }] }).expect(409);
      const paidInv = (await as('ketoan').get(`/invoices?period=2027-03&childId=${s.kids[0].id}`).expect(200)).body.items[0];
      // voiding a paid invoice moves the paid money to the child's credit balance (PM/QA FEE-P06)
      const before = (await as('ketoan').get(`/children/${s.kids[0].id}/credits`).expect(200)).body.creditBalance;
      await as('ketoan').post(`/invoices/${paidInv.id}/void`, { reason: 'Lập sai kỳ' }).expect(200);
      const after = (await as('ketoan').get(`/children/${s.kids[0].id}/credits`).expect(200)).body;
      expect(after.creditBalance).toBe(before + paidInv.paidAmount);
      expect(after.transactions[0]).toMatchObject({ type: 'void_refund', amount: paidInv.paidAmount });
      expect((await as('ketoan').post(`/invoices/${paidInv.id}/void`, { reason: 'x' }).expect(409)).body.code).toBe('ALREADY_VOID');
    });
  });

  describe('health & nutrition', () => {
    it('growth: teacher own class writes, other class 403, parent read-only own child, accountant 403', async () => {
      const g = await as('gv1').post(`/children/${s.kids[0].id}/growth`, { date: todayStr(), heightCm: 100.5, weightKg: 16.2 }).expect(201);
      expect(g.body).toMatchObject({ heightCm: 100.5, weightKg: 16.2, bmi: expect.any(Number) });
      await as('gv1').post(`/children/${s.kids[1].id}/growth`, { date: todayStr(), heightCm: 100 }).expect(403);
      await as('ph1').post(`/children/${s.kids[0].id}/growth`, { date: todayStr(), heightCm: 100 }).expect(403);
      const list = await as('ph1').get(`/children/${s.kids[0].id}/growth`).expect(200);
      expect(list.body.length).toBeGreaterThanOrEqual(3);
      await as('ph1').get(`/children/${s.kids[1].id}/growth`).expect(403);
      await as('ketoan').get(`/children/${s.kids[0].id}/growth`).expect(403);
    });

    it('menu: admin writes, teacher/parent read, accountant 403', async () => {
      const m = await as('ph1').get('/menus').expect(200);
      expect(m.body.days).toHaveLength(7);
      await as('ketoan').get('/menus').expect(403);
      const monday = m.body.weekStart;
      await as('gv1').put('/menus', { weekStart: monday, items: [{ date: monday, meal: 'lunch', dishes: 'X' }] }).expect(403);
      await as('admin').put('/menus', { weekStart: addDays(monday, 1), items: [] }).expect(400);
      const put = await as('admin').put('/menus', { weekStart: monday, items: [{ date: monday, meal: 'lunch', dishes: 'Cơm, canh chua cá lóc' }] }).expect(200);
      expect(put.body.days[0].meals.lunch).toBe('Cơm, canh chua cá lóc');
    });

    it('daily notes: teacher own class, parent own child read-only, accountant/other class 403', async () => {
      const r = await as('gv1').put(`/classes/${s.classes.c1.id}/daily-notes`, { date: todayStr(), items: [{ childId: s.kids[0].id, eating: 'all', sleepMinutes: 120, mood: 'Vui vẻ' }] }).expect(200);
      expect(r.body.items.find((i: any) => i.childId === s.kids[0].id)).toMatchObject({ recorded: true, eating: 'all', sleepMinutes: 120 });
      await as('gv1').put(`/classes/${s.classes.c2.id}/daily-notes`, { date: todayStr(), items: [] }).expect(403);
      await as('gv1').put(`/classes/${s.classes.c1.id}/daily-notes`, { date: addDays(todayStr(), -4), items: [] }).expect(403);
      await as('ph1').put(`/classes/${s.classes.c1.id}/daily-notes`, { date: todayStr(), items: [] }).expect(403);
      const mine = await as('ph1').get(`/children/${s.kids[0].id}/daily-notes`).expect(200);
      expect(mine.body[0]).toMatchObject({ date: todayStr(), eating: 'all' });
      await as('ph1').get(`/children/${s.kids[1].id}/daily-notes`).expect(403);
      await as('ketoan').get(`/children/${s.kids[0].id}/daily-notes`).expect(403);
      await as('ketoan').get(`/classes/${s.classes.c1.id}/daily-notes`).expect(403);
    });
  });
});
