process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';

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
    for (const u of ['admin', 'gv1', 'ketoan', 'ph1']) tokens[u] = (await login(u)).body.accessToken;
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
      expect(r1.body).toMatchObject({ status: 'pending', photoUrl: expect.stringMatching(/^\/uploads\//) });
      expect((await as('gv1').post(`/attendance/${attId}/pickup`, { pickupRequestId: r1.body.id }).expect(403)).body.code).toBe('PICKUP_REQUEST_PENDING');
      // parent sees pending request for own child; other parent does not, and cannot confirm
      const mine = await as('ph1').get('/pickup-requests?status=pending').expect(200);
      expect(mine.body.map((x: any) => x.id)).toContain(r1.body.id);
      tokens.ph2 = (await login('ph2')).body.accessToken;
      expect((await as('ph2').get('/pickup-requests?status=pending').expect(200)).body).toHaveLength(0);
      await as('ph2').post(`/pickup-requests/${r1.body.id}/confirm`, {}).expect(403);
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
});
