process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';

/** B12 – nhập học lại trẻ đã nghỉ. */
describe('B12 re-enroll withdrawn child (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  const T = todayStr();
  const snapshot = async (id: string) => ({
    attendance: (await ds.query(`SELECT id, date, status FROM attendance WHERE child_id = $1 ORDER BY date, id`, [id])),
    notes: (await ds.query(`SELECT id, date FROM daily_notes WHERE child_id = $1 ORDER BY date, id`, [id])),
    invoices: (await ds.query(`SELECT id, period, status, total_amount, paid_amount FROM invoices WHERE child_id = $1 ORDER BY period, id`, [id])),
    payments: (await ds.query(`SELECT p.id, p.amount FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.child_id = $1 ORDER BY p.id`, [id])),
    credit: (await ds.query(`SELECT id, amount, type FROM credit_transactions WHERE child_id = $1 ORDER BY id`, [id])),
  });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'gv2', 'ketoan', 'ph1']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });

  it('re-enroll keeps all history, moves to the new class from startDate, gap days are blocked, audit + stints written', async () => {
    const kid = s.kids.find((k: any) => k.classId === s.classes.c1.id)!;
    const leave = addDays(T, -5), start = addDays(T, -1), gapDay = addDays(T, -3), oldDay = addDays(T, -6);
    await as('admin').put(`/classes/${s.classes.c1.id}/attendance`, { date: oldDay, items: [{ childId: kid.id, status: 'present' }] }).expect(200);
    await as('admin').post(`/children/${kid.id}/withdraw`, { leaveDate: leave, reason: 'Chuyển nhà' }).expect(200);
    const before = await snapshot(kid.id);

    await as('admin').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c2.id, startDate: leave }).expect(400); // must be after leave
    await as('ketoan').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c2.id, startDate: start }).expect(403);
    await as('gv1').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c2.id, startDate: start }).expect(403);
    await as('admin').post(`/children/${kid.id}/reenroll`, { classId: '00000000-0000-4000-8000-000000000000', startDate: start }).expect(404);
    const r = (await as('admin').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c2.id, startDate: start, note: 'Gia đình quay lại' }).expect(200)).body;
    expect(r).toMatchObject({ childId: kid.id, status: 'active', classId: s.classes.c2.id, startDate: start,
      previous: { leaveDate: leave, reason: 'Chuyển nhà', classId: s.classes.c1.id }, enrollment: { kind: 'reenroll', note: 'Gia đình quay lại' },
      outstandingDebt: expect.any(Number), creditBalance: expect.any(Number) });
    await as('admin').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c2.id, startDate: start }).expect(409); // already active

    // history untouched
    expect(await snapshot(kid.id)).toEqual(before);
    expect(before.attendance.length).toBeGreaterThan(0);
    // child detail
    expect((await as('admin').get(`/children/${kid.id}`).expect(200)).body).toMatchObject({ status: 'active', classId: s.classes.c2.id, leaveDate: null, enrolledAt: start });
    // stints
    const st = (await as('admin').get(`/children/${kid.id}/enrollments`).expect(200)).body.items;
    expect(st.map((e: any) => [e.kind, e.endDate, e.startDate])).toEqual([['initial', leave, expect.anything()], ['reenroll', null, start]]);
    expect(st[0]).toMatchObject({ endReason: 'Chuyển nhà', className: s.classes.c1.name });
    await as('gv1').get(`/children/${kid.id}/enrollments`).expect(403);
    // audit
    const [a] = await ds.query(`SELECT * FROM audit_events WHERE action = 'child.reenroll' AND child_id = $1`, [kid.id]);
    expect(a).toMatchObject({ actor_username: 'admin', reason: 'Gia đình quay lại', before: { status: 'withdrawn', leaveDate: leave }, after: { status: 'active', classId: s.classes.c2.id, startDate: start } });
    expect(a.target_label).toContain(s.classes.c2.name);

    // attendance: gap day blocked + not on sheet; new class from start; old stint still editable by admin
    const sheet = async (cls: string, d: string) => (await as('admin').get(`/classes/${cls}/attendance?date=${d}`).expect(200)).body.items.map((i: any) => i.childId);
    expect(await sheet(s.classes.c2.id, gapDay)).not.toContain(kid.id);
    expect(await sheet(s.classes.c2.id, start)).toContain(kid.id);
    expect(await sheet(s.classes.c2.id, T)).toContain(kid.id);
    const gap = await as('admin').put(`/classes/${s.classes.c2.id}/attendance`, { date: gapDay, items: [{ childId: kid.id, status: 'present' }] }).expect(400);
    expect(gap.body.code).toBe('CHILD_NOT_ENROLLED');
    await as('gv2').put(`/classes/${s.classes.c2.id}/attendance`, { date: T, items: [{ childId: kid.id, status: 'present' }] }).expect(200);
    await as('admin').put(`/classes/${s.classes.c2.id}/attendance`, { date: oldDay, items: [{ childId: kid.id, status: 'late' }] }).expect(200);
    // other children unaffected
    expect((await sheet(s.classes.c1.id, gapDay)).length).toBeGreaterThan(0);
  });

  it('future start: no monthly invoice for months before the start month; can withdraw + re-enroll again', async () => {
    const kid = s.kids.filter((k: any) => k.classId === s.classes.c3.id)[1];
    await as('admin').post(`/children/${kid.id}/withdraw`, { leaveDate: T, reason: 'Về quê' }).expect(200);
    const nextMonth = (() => { const [y, m] = T.slice(0, 7).split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
    const start = `${nextMonth}-02`;
    await as('admin').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c3.id, startDate: start }).expect(200);
    await ds.query(`UPDATE invoices SET status = 'void' WHERE child_id = $1 AND period = $2`, [kid.id, T.slice(0, 7)]);
    const g = (await as('ketoan').post('/invoices/generate', { period: T.slice(0, 7), classId: s.classes.c3.id }).expect(201)).body;
    const live = async (p: string) => Number((await ds.query(`SELECT COUNT(*)::int AS n FROM invoices WHERE child_id = $1 AND period = $2 AND status <> 'void'`, [kid.id, p]))[0].n);
    expect(g.created).toBeGreaterThanOrEqual(0);
    expect(await live(T.slice(0, 7))).toBe(0);
    await as('ketoan').post('/invoices/generate', { period: nextMonth, classId: s.classes.c3.id }).expect(201);
    expect(await live(nextMonth)).toBe(1);
    await as('admin').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c3.id, startDate: start }).expect(409);
    await as('admin').post(`/children/${kid.id}/reenroll`, { classId: s.classes.c3.id, startDate: addDays(T, 400) }).expect(400);
  });
});
