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
import { passwordProblem } from '../src/database/bootstrap-admin';
import { spawnSync } from 'child_process';

const nextMonth = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

describe('Round 4: announcements recall/specific/important, 0đ invoices, settings, bootstrap, dashboard attention (e2e)', () => {
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


  const ids = (r: any) => r.body.items.map((x: any) => x.id);
  const unread = async (who: string) => (await as(who).get('/notifications/unread-count').expect(200)).body;

  describe('announcements: own, specific parents, important, recall', () => {
    it('teacher sees own announcements (even audience=parents), scoped to own classes; others do not', async () => {
      const a = await as('gv1').post('/announcements', { title: 'Mang áo mưa', body: 'Phụ huynh để áo mưa trong balo', scope: 'class', classId: s.classes.c1.id, audience: 'parents' }).expect(201);
      expect(a.body).toMatchObject({ mine: true, canRecall: true, important: false, recalled: false, recipientCount: expect.any(Number) });
      const mine = await as('gv1').get('/announcements').expect(200);
      expect(ids(mine)).toContain(a.body.id);
      const m = (await as('gv1').get('/announcements?mine=true').expect(200)).body.items;
      expect(m.map((x: any) => x.id)).toContain(a.body.id);
      expect(m.every((x: any) => x.createdBy === s.users.gv1.id && x.mine)).toBe(true);
      expect(ids(await as('gv2').get('/announcements').expect(200))).not.toContain(a.body.id);
    });

    it('specific parents: teacher only parents of own classes, admin any; only recipients see it; important flag in inbox', async () => {
      const opts = (await as('gv1').get('/announcements/recipients').expect(200)).body.items;
      expect(opts.map((x: any) => x.userId)).toContain(s.users.ph1.id);
      expect(opts.map((x: any) => x.userId)).not.toContain(s.users.ph2.id);
      expect(opts.find((x: any) => x.userId === s.users.ph1.id).children[0]).toMatchObject({ fullName: s.kids[0].fullName });
      await as('gv1').get(`/announcements/recipients?classId=${s.classes.c2.id}`).expect(403);
      await as('gv1').post('/announcements', { title: 'Riêng', body: 'x', recipientUserIds: [s.users.ph2.id] }).expect(403);
      expect((await as('gv1').post('/announcements', { title: 'Riêng', body: 'x', recipientUserIds: [s.users.gv2.id] }).expect(400)).body.code).toBe('INVALID_RECIPIENTS');
      await as('gv1').post('/announcements', { title: 'Riêng', body: 'x', audience: 'specific' }).expect(400);
      await as('gv1').post('/announcements', { title: 'Riêng', body: 'x', scope: 'class', classId: s.classes.c1.id, audience: 'all', recipientUserIds: [s.users.ph1.id] }).expect(400);

      const before = await unread('ph1');
      const sp = await as('gv1').post('/announcements', { title: 'Bé An quên áo', body: 'Mai phụ huynh mang áo cho bé', recipientUserIds: [s.users.ph1.id], important: true }).expect(201);
      expect(sp.body).toMatchObject({ audience: 'specific', important: true, recipientUserIds: [s.users.ph1.id], recipientCount: 1, scope: 'school' });
      const after = await unread('ph1');
      expect(after.unreadCount).toBe(before.unreadCount + 1);
      expect(after.importantUnreadCount).toBe(before.importantUnreadCount + 1);
      const inbox = (await as('ph1').get('/notifications').expect(200)).body;
      expect(inbox.items.find((n: any) => n.announcementId === sp.body.id)).toMatchObject({ important: true, data: expect.objectContaining({ important: true }) });
      const p1 = (await as('ph1').get('/announcements').expect(200)).body.items.find((x: any) => x.id === sp.body.id);
      expect(p1).toBeDefined();
      expect(p1.recipientUserIds).toBeUndefined(); // parents never see the recipient list
      expect(ids(await as('ph2').get('/announcements').expect(200))).not.toContain(sp.body.id);
      expect(ids(await as('gv2').get('/announcements').expect(200))).not.toContain(sp.body.id);
      expect(ids(await as('gv1').get('/announcements').expect(200))).toContain(sp.body.id);
      expect(ids(await as('admin').get('/announcements').expect(200))).toContain(sp.body.id);
      const adm = await as('admin').post('/announcements', { title: 'Gửi PH Bình', body: 'x', recipientUserIds: [s.users.ph2.id] }).expect(201);
      expect(ids(await as('ph2').get('/announcements').expect(200))).toContain(adm.body.id);
    });

    it('recall (DELETE): soft-delete with recalledAt/By, inbox items + unread counts gone for all recipients', async () => {
      const a = await as('gv1').post('/announcements', { title: 'Thu hồi tôi', body: 'nhầm', scope: 'class', classId: s.classes.c1.id, important: true }).expect(201);
      const before = await unread('ph1');
      const n = (await as('ph1').get('/notifications').expect(200)).body.items.find((x: any) => x.announcementId === a.body.id);
      expect(n).toBeDefined();
      await as('gv2').del(`/announcements/${a.body.id}`).expect(403);
      await as('ph1').del(`/announcements/${a.body.id}`).expect(403);
      await as('gv1').del(`/announcements/${a.body.id}`).expect(204);
      expect((await as('gv1').del(`/announcements/${a.body.id}`).expect(409)).body.code).toBe('ALREADY_RECALLED');
      const after = await unread('ph1');
      expect(after.unreadCount).toBe(before.unreadCount - 1);
      expect(after.importantUnreadCount).toBe(before.importantUnreadCount - 1);
      const inbox = (await as('ph1').get('/notifications?limit=100').expect(200)).body;
      expect(inbox.items.map((x: any) => x.announcementId)).not.toContain(a.body.id);
      expect(inbox.unreadCount).toBe(after.unreadCount);
      await as('ph1').post(`/notifications/${n.id}/read`).expect(404);
      expect(ids(await as('ph1').get('/announcements').expect(200))).not.toContain(a.body.id);
      expect(ids(await as('gv1').get('/announcements').expect(200))).not.toContain(a.body.id);
      const hist = (await as('gv1').get('/announcements?includeRecalled=true').expect(200)).body.items.find((x: any) => x.id === a.body.id);
      expect(hist).toMatchObject({ recalled: true, recalledBy: s.users.gv1.id, canRecall: false });
      expect(hist.recalledAt).toBeTruthy();
      expect(ids(await as('ph1').get('/announcements?includeRecalled=true').expect(200))).not.toContain(a.body.id);
      // kept in DB (soft delete), notifications kept but hidden
      const [row] = await ds.query('SELECT recalled_at, recalled_by FROM announcements WHERE id = $1', [a.body.id]);
      expect(row.recalled_by).toBe(s.users.gv1.id);
      const [{ hidden }] = await ds.query('SELECT COUNT(*)::int AS hidden FROM notifications WHERE announcement_id = $1 AND hidden_at IS NOT NULL', [a.body.id]);
      expect(hidden).toBeGreaterThan(0);
      // admin may recall anyone's
      const b = await as('gv1').post('/announcements', { title: 'B', body: 'b', scope: 'class', classId: s.classes.c1.id }).expect(201);
      await as('admin').del(`/announcements/${b.body.id}`).expect(204);
    });
  });

  describe('0đ invoices (miễn/giảm 100%)', () => {
    it('status paid, note Miễn/giảm 100%, waived=true, cannot be paid, receipt 404 cleanly', async () => {
      const k = s.kids[24];
      const r = await as('ketoan').post('/invoices', { childId: k.id, period: '2027-08', applyCredit: false, lines: [
        { description: 'Học phí', unitPrice: 1000000 }, { kind: 'discount', description: 'Miễn học phí', unitPrice: 1000000, reason: 'Diện chính sách' }] }).expect(201);
      expect(r.body).toMatchObject({ totalAmount: 0, paidAmount: 0, status: 'paid', waived: true, payments: [] });
      expect(r.body.note).toContain('Miễn/giảm 100%');
      expect((await as('ketoan').post(`/invoices/${r.body.id}/payments`, { amount: 1000, method: 'cash' }).expect(409)).body.code).toBe('ZERO_INVOICE');
      const nr = await as('ketoan').get(`/invoices/${r.body.id}/receipt`).expect(404);
      expect(nr.body).toMatchObject({ code: 'NO_RECEIPT', message: expect.stringContaining('0đ') });
      await as('ketoan').get(`/payments/${r.body.id}/receipt`).expect(404);
      await as('ketoan').get('/payments/not-a-uuid/receipt').expect(400);
      // removing the discount -> no longer waived, note removed; re-adding it -> note back
      const disc = r.body.lines.find((l: any) => l.kind === 'discount');
      const x = await as('ketoan').del(`/invoices/${r.body.id}/lines/${disc.id}`).expect(200);
      expect(x.body).toMatchObject({ totalAmount: 1000000, status: 'unpaid', waived: false });
      expect(x.body.note ?? '').not.toContain('Miễn/giảm 100%');
      const y = await as('ketoan').post(`/invoices/${r.body.id}/lines`, { kind: 'discount', description: 'Miễn', unitPrice: 1000000, reason: 'Diện chính sách' }).expect(201);
      expect(y.body).toMatchObject({ totalAmount: 0, status: 'paid', waived: true, note: 'Miễn/giảm 100%' });
    });
    it('0đ because prepaid credit covered it is NOT a waiver; paid invoice receipt via /invoices/:id/receipt', async () => {
      const k = s.kids[25];
      await as('ketoan').post(`/children/${k.id}/prepayments`, { amount: 500000, method: 'cash' }).expect(201);
      const r = await as('ketoan').post('/invoices', { childId: k.id, period: '2027-08', lines: [{ description: 'Dã ngoại', unitPrice: 200000 }] }).expect(201);
      expect(r.body).toMatchObject({ totalAmount: 0, status: 'paid', waived: false });
      expect(r.body.note ?? '').not.toContain('Miễn/giảm 100%');
      expect((await as('ketoan').get(`/invoices/${r.body.id}/receipt`).expect(404)).body.code).toBe('NO_RECEIPT');
      const p = await as('ketoan').post('/invoices', { childId: k.id, period: '2027-09', applyCredit: false, lines: [{ description: 'Đồng phục', unitPrice: 150000 }] }).expect(201);
      const pay = await as('ketoan').post(`/invoices/${p.body.id}/payments`, { amount: 150000, method: 'cash' }).expect(201);
      const rc = await as('ketoan').get(`/invoices/${p.body.id}/receipt`).expect(200);
      expect(rc.body.receiptNo).toBe(pay.body.receiptNo);
      await as('ph2').get(`/invoices/${p.body.id}/receipt`).expect(403);
    });
  });

  describe('settings / school', () => {
    it('public, values from env, used by receipts', async () => {
      process.env.SCHOOL_NAME = 'Trường MN Test'; process.env.SCHOOL_ADDRESS = '1 Lê Lợi'; process.env.SCHOOL_PHONE = '0281234567';
      const r = await request(http).get('/api/v1/settings/school').expect(200);
      expect(r.body).toEqual({ name: 'Trường MN Test', address: '1 Lê Lợi', phone: '0281234567' });
      const k = s.kids[26];
      const pay = await as('ketoan').post(`/children/${k.id}/prepayments`, { amount: 10000, method: 'cash' }).expect(201);
      expect(pay.body.school).toEqual(r.body);
    });
  });

  describe('dashboard attention (admin)', () => {
    it('classes not marked, allergy children present, pending pickup requests', async () => {
      const d = (await as('admin').get(`/dashboard/summary?date=${todayStr()}`).expect(200)).body;
      expect(d.attention).toMatchObject({ classesNotMarked: expect.any(Array), classesNotMarkedCount: expect.any(Number), classesPartlyMarked: expect.any(Array),
        allergyChildrenPresent: expect.any(Array), allergyChildrenPresentCount: expect.any(Number), pendingPickupRequests: expect.any(Number) });
      const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM children c JOIN attendance a ON a.child_id = c.id AND a.date = $1
        WHERE c.status = 'active' AND a.status IN ('present','late') AND COALESCE(c.allergies,'') <> ''`, [todayStr()]);
      expect(d.attention.allergyChildrenPresentCount).toBe(n);
      for (const x of d.attention.allergyChildrenPresent) expect(x.allergies).toBeTruthy();
      // a far-future day: every class with children is unmarked
      const f = (await as('admin').get('/dashboard/summary?date=2030-01-07').expect(200)).body;
      expect(f.attention.classesNotMarkedCount).toBe(3);
      expect(f.attention.allergyChildrenPresentCount).toBe(0);
      expect((await as('gv1').get('/dashboard/summary').expect(200)).body.attention).toBeUndefined();
      expect((await as('ketoan').get('/dashboard/summary').expect(200)).body.attention).toBeUndefined();
    });
  });

  describe('production safety', () => {
    it('bootstrap:admin refuses weak passwords', () => {
      expect(passwordProblem('hieutruong', '123456')).toBeTruthy();
      expect(passwordProblem('hieutruong', '1234567890')).toBeTruthy();
      expect(passwordProblem('hieutruong', 'abcdefghijk')).toBeTruthy();
      expect(passwordProblem('hieutruong', 'hieutruong2026')).toBeTruthy();
      expect(passwordProblem('hieutruong', 'Admin@123')).toBeTruthy();
      expect(passwordProblem('hieutruong', 'HoaSen-2026-xK9')).toBeNull();
    });
    it('demo seed refuses NODE_ENV=production (before touching the DB)', () => {
      const r = spawnSync('npx', ['ts-node', '--transpile-only', 'src/database/seed.ts', '--force'], { env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none' }, encoding: 'utf8' });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('bootstrap:admin');
    }, 30000);
  });
});
