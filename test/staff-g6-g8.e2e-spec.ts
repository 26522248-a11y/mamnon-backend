process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.ANNUAL_LEAVE_DAYS = '2';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';
import { isoWeekday } from '../src/staff/staff-time';

/** G6 leave types + half day, G7/H1 approval with substitute + notifications, G8 parents + substitute medicines. */
describe('Staff G6–G8 (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource, s: Awaited<ReturnType<typeof seed>>;
  const tok: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`).send(body),
  });
  const notes = async (who: string, type: string) => (await as(who).get('/notifications?limit=100').expect(200)).body.items.filter((n: any) => n.type === type);
  const T = todayStr();
  const MON = addDays(T, 8 - isoWeekday(T)); // next Monday
  const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  let shift: any, leaveId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>()); await app.init(); http = app.getHttpServer();
    ds = app.get(DataSource); await ds.runMigrations(); s = await seed(ds);
    await ds.query('TRUNCATE staff_substitutions, staff_leaves, staff_checkins, staff_shift_assignments, staff_shifts CASCADE');
    for (const u of ['admin', 'gv1', 'gv2', 'gv3', 'ph1']) tok[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    shift = (await as('admin').post('/staff/shifts', { name: 'Ca ngày', startTime: '07:00', endTime: '16:30' }).expect(201)).body;
  });
  afterAll(async () => { await app?.close(); });

  it('G6: type + half day + work days; validation; annual balance', async () => {
    await as('gv1').post('/staff/leaves', { type: 'sick', fromDate: MON, toDate: addDays(MON, 1), session: 'morning' }).expect(400).expect((r) => expect(r.body.code).toBe('HALF_DAY_SINGLE_DATE'));
    await as('gv1').post('/staff/leaves', { type: 'holiday', fromDate: MON, toDate: MON }).expect(400);
    const r = await as('gv1').post('/staff/leaves', { type: 'sick', fromDate: MON, toDate: MON, session: 'morning', handoverNote: 'Bé Na dị ứng sữa' }).expect(201);
    expect(r.body).toMatchObject({ type: 'sick', typeLabel: 'Ốm', session: 'morning', sessionLabel: 'Buổi sáng', days: 0.5, reason: 'Ốm', handoverNote: 'Bé Na dị ứng sữa', status: 'pending',
      classes: [{ id: s.classes.c1.id }] });
    leaveId = r.body.id;
    // afternoon of the same day does not clash; full day does
    const pm = await as('gv1').post('/staff/leaves', { type: 'personal', fromDate: MON, toDate: MON, session: 'afternoon' }).expect(201);
    await as('gv1').post('/staff/leaves', { type: 'personal', fromDate: MON, toDate: MON }).expect(409);
    await as('gv1').post(`/staff/leaves/${pm.body.id}/cancel`, {}).expect(200);
    // Mon–Fri only: a full week + weekend = 5 days
    expect((await as('gv1').get(`/staff/leaves/preview?fromDate=${MON}&toDate=${addDays(MON, 6)}`).expect(200)).body).toEqual({ days: 5 });
    expect((await as('gv1').get(`/staff/leaves/preview?fromDate=${MON}&toDate=${MON}&session=afternoon`).expect(200)).body).toEqual({ days: 0.5 });
    // annual: allowance 2 (env)
    const e = await as('gv2').post('/staff/leaves', { type: 'annual', fromDate: addDays(MON, 1), toDate: addDays(MON, 3) }).expect(409);
    expect(e.body).toMatchObject({ code: 'ANNUAL_EXCEEDED' });
    await as('gv2').post('/staff/leaves', { type: 'annual', fromDate: addDays(MON, 1), toDate: addDays(MON, 1) }).expect(201);
    expect((await as('gv2').get('/staff/leaves/balance').expect(200)).body).toMatchObject({ annualAllowance: 2, annualPending: 1, annualRemaining: 1 });
    await as('gv2').get(`/staff/leaves/balance?userId=${s.users.gv1.id}`).expect(403);
  });

  it('G7/H1: admin notified with url → approval page; approve with substitute; teacher + substitute + parents notified; no double approve', async () => {
    const n = (await notes('admin', 'staff_leave')).find((x: any) => x.data?.leaveId === leaveId);
    expect(n.title).toBe(`${s.users.gv1.name} xin nghỉ ốm ${dm(MON)} (buổi sáng)`);
    expect(n.body).toMatch(/Mầm 1 cần cô trông thay/);
    expect(n.data.url).toBe(`/staff/leaves/${leaveId}`);
    const page = (await as('admin').get(`/staff/leaves/${leaveId}`).expect(200)).body;
    expect(page.coverage).toHaveLength(1);
    expect(page.coverage[0]).toMatchObject({ date: MON, class: { id: s.classes.c1.id }, shift: { id: shift.id }, substitution: null });
    expect(page.coverage[0].suggestions.map((x: any) => x.userId)).toContain(s.users.gv3.id);
    await as('gv2').get(`/staff/leaves/${leaveId}`).expect(403);
    const ok = (await as('admin').post(`/staff/leaves/${leaveId}/approve`, { note: 'Nghỉ khoẻ', substituteUserId: s.users.gv3.id }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'approved', substitutions: [{ date: MON, session: 'morning', class: { id: s.classes.c1.id }, substituteTeacher: { id: s.users.gv3.id } }] });
    await as('admin').post(`/staff/leaves/${leaveId}/approve`, { substituteUserId: s.users.gv3.id }).expect(409);
    const d = (await notes('gv1', 'staff_leave_decision')).find((x: any) => x.data?.leaveId === leaveId);
    expect(d.title).toBe(`✓ Đơn nghỉ ốm ${dm(MON)} (buổi sáng) đã duyệt`);
    expect(d.body).toContain(`Cô trông thay: ${s.users.gv3.name}`);
    const sub = (await notes('gv3', 'substitution')).find((x: any) => x.data?.leaveId === leaveId);
    expect(sub.body).toContain('Bàn giao: Bé Na dị ứng sữa');
    const pa = (await notes('ph1', 'substitute_teacher'));
    expect(pa).toHaveLength(1);
    expect(pa[0]).toMatchObject({ title: `↔ Cô trông thay ngày ${dm(MON)}`, data: { classId: s.classes.c1.id, session: 'morning', substituteName: s.users.gv3.name, date: MON, className: 'Mầm 1' } }); // P9
    // the substitute sees the handover note but not the reason
    const sv = (await as('gv3').get(`/staff/leaves/${leaveId}`).expect(200)).body;
    expect(sv.handoverNote).toBe('Bé Na dị ứng sữa'); expect(sv.reason).toBeUndefined();
    // reject needs a reason; teacher gets it
    const other = (await as('gv2').post('/staff/leaves', { type: 'personal', fromDate: addDays(MON, 4), toDate: addDays(MON, 4) }).expect(201)).body;
    await as('admin').post(`/staff/leaves/${other.id}/reject`, {}).expect(400);
    await as('admin').post(`/staff/leaves/${other.id}/reject`, { note: 'Trùng hội giảng' }).expect(200);
    const rj = (await notes('gv2', 'staff_leave_decision')).find((x: any) => x.data?.leaveId === other.id);
    expect(rj).toMatchObject({ title: `Đơn nghỉ việc riêng ${dm(addDays(MON, 4))} bị từ chối`, body: 'Lý do: Trùng hội giảng' });
  });

  it('G6: timesheet counts half day as 0.5', async () => {
    const r = (await as('admin').get(`/staff/attendance?from=${MON}&to=${MON}&userId=${s.users.gv1.id}`).expect(200)).body;
    const row = r.items.find((x: any) => x.user.id === s.users.gv1.id);
    expect(row.days[0]).toMatchObject({ status: 'leave', leaveType: 'sick', leaveSession: 'morning', leaveDays: 0.5 });
    expect(row.totals.leave).toBe(0.5);
  });

  it('G8: covering today → parents told; substitute sees + gives class medicines (once); others 403', async () => {
    const kid = s.kids[0];
    const [m] = await ds.query(`INSERT INTO medicines (child_id, class_id, date, name, dose) VALUES ($1, $2, $3, 'Hạ sốt', '5 ml') RETURNING id`, [kid.id, s.classes.c1.id, T]);
    const [dose] = await ds.query(`INSERT INTO medicine_doses (medicine_id, time) VALUES ($1, '10:00') RETURNING id`, [m.id]);
    await as('gv3').post(`/medicine-doses/${dose.id}/given`, {}).expect(403); // not covering yet
    await as('admin').post('/staff/substitutions', { date: T, shiftId: shift.id, classId: s.classes.c1.id, substituteUserId: s.users.gv3.id, absentUserId: s.users.gv1.id }).expect(201);
    expect((await notes('ph1', 'substitute_teacher')).some((x: any) => x.title === '↔ Cô trông thay hôm nay' && x.body.startsWith(`${s.users.gv3.name} trông lớp Mầm 1`))).toBe(true);
    const today = (await as('gv3').get('/staff/me/substitutions/today').expect(200)).body;
    expect(today.items[0]).toMatchObject({ class: { id: s.classes.c1.id }, absentTeacher: { id: s.users.gv1.id } });
    expect(today.items[0].medicines[0]).toMatchObject({ childName: kid.fullName, name: 'Hạ sốt', doses: [{ id: dose.id, givenAt: null }] });
    await as('gv3').get(`/classes/${s.classes.c1.id}/parent-messages`).expect(200);
    await as('gv3').get(`/children/${kid.id}/medicines`).expect(200);
    await as('gv2').get(`/classes/${s.classes.c1.id}/parent-messages`).expect(403);
    await as('gv2').post(`/medicine-doses/${dose.id}/given`, {}).expect(403);
    const g = (await as('gv3').post(`/medicine-doses/${dose.id}/given`, {}).expect(200)).body;
    expect(g.doses[0]).toMatchObject({ givenAt: expect.any(String), givenByName: s.users.gv3.name });
    await as('gv3').post(`/medicine-doses/${dose.id}/given`, {}).expect(409);
    const pn = await notes('ph1', 'medicine_given');
    expect(pn).toHaveLength(1);
    expect(pn[0].title).toMatch(new RegExp(`^Bé ${kid.fullName.split(' ').pop()} đã được cho uống thuốc lúc \\d\\d:\\d\\d$`));
    expect(pn[0].body).toContain('(cô trông thay)');
  });
});
