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
import { isoWeekday } from '../src/staff/staff-time';

/** Quản lý giáo viên: ca làm, xếp ca, chấm công, nghỉ phép, trông thay. */
describe('Staff module (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    del: (url: string) => request(http).delete('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
  });
  const T = todayStr();
  const MON = addDays(addDays(T, -14), 1 - isoWeekday(addDays(T, -14)));
  const [TUE, WED, THU, FRI] = [1, 2, 3, 4].map((n) => addDays(MON, n));
  const at = (d: string, hm: string) => `${d}T${hm}:00+07:00`;
  let shift: any, gv4: any;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    await ds.query('TRUNCATE staff_substitutions, staff_leaves, staff_checkins, staff_shift_assignments, staff_shifts CASCADE');
    for (const u of ['admin', 'gv1', 'gv2', 'gv3', 'ketoan', 'ph1']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    gv4 = (await as('admin').post('/users', { username: 'gv4', password: '123456', name: 'Cô Thu', role: 'teacher' }).expect(201)).body;
  });
  afterAll(async () => { await app?.close(); });

  it('shifts: admin CRUD, validation, staff can read, others 403', async () => {
    await as('admin').post('/staff/shifts', { name: 'Sai', startTime: '16:00', endTime: '07:00' }).expect(400);
    await as('admin').post('/staff/shifts', { name: 'Sai', startTime: '7h', endTime: '16:00' }).expect(400);
    await as('gv1').post('/staff/shifts', { name: 'X', startTime: '07:00', endTime: '16:00' }).expect(403);
    await as('ketoan').post('/staff/shifts', { name: 'X', startTime: '07:00', endTime: '16:00' }).expect(403);
    shift = (await as('admin').post('/staff/shifts', { name: 'Ca sáng', startTime: '07:00', endTime: '16:00', lateGraceMinutes: 5 }).expect(201)).body;
    expect(shift).toMatchObject({ name: 'Ca sáng', startTime: '07:00', endTime: '16:00', lateGraceMinutes: 5, isActive: true });
    const tmp = (await as('admin').post('/staff/shifts', { name: 'Ca tối', startTime: '17:00', endTime: '19:00' }).expect(201)).body;
    expect((await as('admin').patch(`/staff/shifts/${tmp.id}`, { endTime: '19:30' }).expect(200)).body.endTime).toBe('19:30');
    expect((await as('admin').del(`/staff/shifts/${tmp.id}`).expect(200)).body).toMatchObject({ deleted: true });
    expect((await as('gv1').get('/staff/shifts').expect(200)).body.items.map((x: any) => x.name)).toEqual(['Ca sáng']);
    await as('ph1').get('/staff/shifts').expect(403);
  });

  it('assignments: bulk by range + weekdays, duplicates skipped, own view for teachers', async () => {
    await as('gv1').post('/staff/assignments', { userId: s.users.gv1.id, shiftId: shift.id, dates: [MON] }).expect(403);
    await as('ketoan').post('/staff/assignments', { userId: s.users.gv1.id, shiftId: shift.id, dates: [MON] }).expect(403);
    await as('admin').post('/staff/assignments', { userId: s.users.ph1.id, shiftId: shift.id, dates: [MON] }).expect(400);
    const r = (await as('admin').post('/staff/assignments', { userId: s.users.gv1.id, shiftId: shift.id, classId: s.classes.c1.id, from: MON, to: addDays(MON, 6) }).expect(201)).body;
    expect(r.created).toBe(5); // Mon–Fri only
    expect(r.items[0]).toMatchObject({ date: MON, className: s.classes.c1.name, shift: { name: 'Ca sáng' } });
    expect((await as('admin').post('/staff/assignments', { userId: s.users.gv1.id, shiftId: shift.id, classId: s.classes.c1.id, dates: [MON, TUE] }).expect(201)).body)
      .toMatchObject({ created: 0, skippedExisting: [MON, TUE] });
    await as('admin').post('/staff/assignments', { userId: s.users.gv2.id, shiftId: shift.id, classId: s.classes.c2.id, from: MON, to: FRI }).expect(201);
    await as('admin').post('/staff/assignments', { userId: s.users.gv3.id, shiftId: shift.id, classId: s.classes.c3.id, from: MON, to: FRI }).expect(201);
    const mine = (await as('gv1').get(`/staff/assignments?from=${MON}&to=${FRI}`).expect(200)).body.items;
    expect(mine).toHaveLength(5);
    expect(new Set(mine.map((a: any) => a.userId))).toEqual(new Set([s.users.gv1.id]));
    expect((await as('admin').get(`/staff/assignments?from=${MON}&to=${FRI}`).expect(200)).body.items).toHaveLength(15);
    // delete
    const extra = (await as('admin').post('/staff/assignments', { userId: gv4.id, shiftId: shift.id, dates: [addDays(T, 30)] }).expect(201)).body.items[0];
    await as('admin').del(`/staff/assignments/${extra.id}`).expect(204);
    await as('admin').del(`/staff/assignments/${extra.id}`).expect(404);
  });

  it('admin corrections + leave → per-day status full / late / leave / absent; audit', async () => {
    await as('admin').put(`/staff/attendance/${s.users.gv1.id}/${MON}`, { checkInAt: at(MON, '06:58'), checkOutAt: at(MON, '16:05'), note: 'Quên chấm' }).expect(200);
    await as('admin').put(`/staff/attendance/${s.users.gv1.id}/${TUE}`, { checkInAt: at(TUE, '07:22'), note: 'Quên chấm' }).expect(200);
    await as('admin').put(`/staff/attendance/${s.users.gv1.id}/${TUE}`, { checkInAt: at(WED, '07:00'), note: 'x' }).expect(400); // wrong day
    await as('admin').put(`/staff/attendance/${s.users.gv1.id}/${addDays(T, 1)}`, { checkInAt: at(addDays(T, 1), '07:00'), note: 'x' }).expect(400);
    await as('admin').put(`/staff/attendance/${s.users.gv1.id}/${MON}`, { note: '' }).expect(400);
    await as('gv1').put(`/staff/attendance/${s.users.gv1.id}/${MON}`, { checkInAt: at(MON, '06:00'), note: 'x' }).expect(403);
    for (const d of [MON, TUE, FRI]) await as('admin').put(`/staff/attendance/${s.users.gv2.id}/${d}`, { checkInAt: at(d, '06:50'), note: 'nhập bù' }).expect(200);
    for (const d of [MON, TUE, WED, THU, FRI]) await as('admin').put(`/staff/attendance/${s.users.gv3.id}/${d}`, { checkInAt: at(d, '06:55'), note: 'nhập bù' }).expect(200);
    const lv = (await as('admin').post('/staff/leaves', { userId: s.users.gv2.id, fromDate: WED, toDate: THU, reason: 'Ốm' }).expect(201)).body;
    expect(lv).toMatchObject({ status: 'approved', userId: s.users.gv2.id });
    const [a] = await ds.query(`SELECT * FROM audit_events WHERE action = 'staff_attendance.correct' ORDER BY created_at LIMIT 1`);
    expect(a).toMatchObject({ actor_username: 'admin', reason: 'Quên chấm' });

    const rep = (await as('admin').get(`/staff/attendance?from=${MON}&to=${FRI}&date=${THU}`).expect(200)).body;
    const row = (id: string) => rep.items.find((r: any) => r.user.id === id);
    const st = (id: string) => row(id).days.map((d: any) => d.status);
    expect(rep.dates).toEqual([MON, TUE, WED, THU, FRI]);
    expect(st(s.users.gv1.id)).toEqual(['full', 'late', 'absent', 'absent', 'absent']);
    expect(row(s.users.gv1.id).days[1]).toMatchObject({ lateMinutes: 22, checkInAt: expect.any(String), checkOutAt: null, checkInSource: 'admin' });
    expect(row(s.users.gv1.id).days[0]).toMatchObject({ checkInAt: new Date(at(MON, '06:58')).toISOString(), checkOutAt: new Date(at(MON, '16:05')).toISOString() });
    expect(st(s.users.gv2.id)).toEqual(['full', 'full', 'leave', 'leave', 'full']);
    expect(row(s.users.gv2.id).totals).toMatchObject({ workDays: 3, leave: 2 });
    expect(row(gv4.id).days.map((d: any) => d.status)).toEqual(['off', 'off', 'off', 'off', 'off']);
    // summary for Thursday: gv3 present, gv2 leave, gv1 absent, Chồi (c2) needs a substitute
    expect(rep.summary).toMatchObject({ date: THU, present: 1, late: 0, leave: 1, absent: 1, needSubstitute: 2 });
    // ^ c2 (gv2 on leave) and c1 (gv1 absent, no check-in)
  });

  it('substitution needs + suggestions; assign substitute (busy / leave / slot rules); status substitute', async () => {
    const needs = (await as('admin').get(`/staff/substitutions/needs?date=${WED}`).expect(200)).body.items;
    const c2 = needs.find((n: any) => n.class.id === s.classes.c2.id);
    expect(c2).toMatchObject({ date: WED, shift: { id: shift.id }, class: { name: s.classes.c2.name, children: expect.any(Number) },
      absentTeachers: [{ id: s.users.gv2.id, reason: 'leave' }] });
    expect(c2.suggestions[0]).toMatchObject({ userId: gv4.id, freeNote: 'Rảnh cả ngày' });
    expect(c2.suggestions.map((x: any) => x.userId)).not.toContain(s.users.gv3.id); // busy with own class
    await as('gv1').get(`/staff/substitutions/needs?date=${WED}`).expect(403);

    const body = { date: WED, shiftId: shift.id, classId: s.classes.c2.id, substituteUserId: s.users.gv3.id, reason: 'Cô nghỉ phép' };
    expect((await as('admin').post('/staff/substitutions', body).expect(409)).body.code).toBe('SUBSTITUTE_BUSY');
    await as('admin').post('/staff/substitutions', { ...body, date: addDays(T, -40) }).expect(400);
    await as('admin').post('/staff/substitutions', { ...body, substituteUserId: s.users.gv2.id }).expect(400); // same as absent teacher
    expect((await as('admin').post('/staff/substitutions', { ...body, classId: s.classes.c3.id, substituteUserId: s.users.gv2.id }).expect(409)).body.code).toBe('SUBSTITUTE_ON_LEAVE');
    await as('admin').post('/staff/substitutions', { ...body, substituteUserId: s.users.ph1.id }).expect(400);
    await as('gv1').post('/staff/substitutions', body).expect(403);
    const sub = (await as('admin').post('/staff/substitutions', { ...body, force: true }).expect(201)).body;
    expect(sub).toMatchObject({ date: WED, shift: { name: 'Ca sáng' }, class: { id: s.classes.c2.id, name: s.classes.c2.name },
      absentTeacher: { id: s.users.gv2.id }, substituteTeacher: { id: s.users.gv3.id }, reason: 'Cô nghỉ phép' });
    expect((await as('admin').post('/staff/substitutions', { ...body, substituteUserId: gv4.id }).expect(409)).body.code).toBe('SLOT_TAKEN');
    // Thursday: gv4 covers c2 (free)
    const sub2 = (await as('admin').post('/staff/substitutions', { ...body, date: THU, substituteUserId: gv4.id }).expect(201)).body;
    expect((await as('admin').post('/staff/substitutions', { ...body, date: THU, classId: s.classes.c1.id, substituteUserId: gv4.id }).expect(409)).body.code).toBe('SUBSTITUTE_BUSY');
    // needs: Wed c2 now covered
    expect((await as('admin').get(`/staff/substitutions/needs?date=${WED}`).expect(200)).body.items.map((n: any) => n.class.id)).not.toContain(s.classes.c2.id);
    // status: gv3 checked in on Wed while covering → substitute; gv4 covering Thu without check-in → absent
    const rep = (await as('admin').get(`/staff/attendance?from=${MON}&to=${FRI}`).expect(200)).body;
    const gv3 = rep.items.find((r: any) => r.user.id === s.users.gv3.id).days.find((d: any) => d.date === WED);
    expect(gv3).toMatchObject({ status: 'substitute', substituteFor: [{ classId: s.classes.c2.id, className: s.classes.c2.name, absentUser: { id: s.users.gv2.id } }] });
    expect(rep.items.find((r: any) => r.user.id === gv4.id).days.find((d: any) => d.date === THU).status).toBe('absent');
    expect(rep.items.find((r: any) => r.user.id === s.users.gv2.id).days.find((d: any) => d.date === WED).coveredBy[0]).toMatchObject({ substituteUser: { id: s.users.gv3.id } });
    // lists
    const forGv3 = (await as('gv3').get(`/staff/substitutions?from=${MON}&to=${FRI}`).expect(200)).body.items;
    expect(forGv3.map((x: any) => x.id)).toEqual([sub.id]);
    const forGv2 = (await as('gv2').get(`/staff/substitutions?from=${MON}&to=${FRI}`).expect(200)).body.items; // covered for her + her class
    expect(forGv2.map((x: any) => x.id).sort()).toEqual([sub.id, sub2.id].sort());
    expect((await as('gv1').get(`/staff/substitutions?from=${MON}&to=${FRI}`).expect(200)).body.items).toHaveLength(0);
    // notification to the substitute
    expect((await ds.query(`SELECT type FROM notifications WHERE user_id = $1`, [gv4.id])).map((r: any) => r.type)).toContain('substitution');
    // remove (audited)
    await as('admin').del(`/staff/substitutions/${sub2.id}`).expect(204);
    await as('admin').del(`/staff/substitutions/${sub2.id}`).expect(404);
    expect((await ds.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at`, [sub2.id])).map((r: any) => r.action)).toEqual(['substitution.assign', 'substitution.remove']);
    // used shift cannot be hard-deleted
    expect((await as('admin').del(`/staff/shifts/${shift.id}`).expect(200)).body).toMatchObject({ deleted: false, deactivated: true });
    await as('admin').patch(`/staff/shifts/${shift.id}`, { isActive: true }).expect(200);
  });

  it('teacher self check-in / check-out today, own report only, /me/today', async () => {
    await as('admin').post('/staff/assignments', { userId: s.users.gv1.id, shiftId: shift.id, classId: s.classes.c1.id, dates: [T] }).expect(201);
    await as('ph1').post('/staff/me/check-in', {}).expect(403);
    expect((await as('gv1').post('/staff/me/check-out', {}).expect(409)).body.code).toBe('NOT_CHECKED_IN');
    const r = (await as('gv1').post('/staff/me/check-in', { note: 'vào ca' }).expect(200)).body;
    expect(r).toMatchObject({ date: T, checkInAt: expect.any(String), checkOutAt: null, canCheckIn: false, canCheckOut: true, shifts: [{ name: 'Ca sáng' }],
      classes: [{ id: s.classes.c1.id }] });
    expect(['full', 'late']).toContain(r.status);
    expect(r.week).toHaveLength(5);
    expect((await as('gv1').post('/staff/me/check-in', {}).expect(409)).body.code).toBe('ALREADY_CHECKED_IN');
    const o = (await as('gv1').post('/staff/me/check-out', {}).expect(200)).body;
    expect(o).toMatchObject({ canCheckOut: false, checkOutAt: expect.any(String) });
    expect((await as('gv1').post('/staff/me/check-out', {}).expect(409)).body.code).toBe('ALREADY_CHECKED_OUT');
    // accountant can check in too (no shift → full)
    expect((await as('ketoan').post('/staff/me/check-in', {}).expect(200)).body).toMatchObject({ status: 'full', shifts: [] });
    // own report only
    const mine = (await as('gv1').get(`/staff/attendance?from=${MON}&to=${FRI}&userId=${s.users.gv2.id}`).expect(200)).body.items;
    expect(mine.map((x: any) => x.user.id)).toEqual([s.users.gv1.id]);
    await as('admin').get(`/staff/attendance?from=${MON}&to=${addDays(MON, 70)}`).expect(400);
  });

  it('leave requests: request → admin notified; overlap 409; approve/reject rules; cancel', async () => {
    const d1 = addDays(T, 10);
    await as('gv1').post('/staff/leaves', { fromDate: d1, toDate: addDays(d1, -1), reason: 'x' }).expect(400);
    await as('gv1').post('/staff/leaves', { fromDate: d1, toDate: d1, reason: 'x', userId: s.users.gv2.id }).expect(403);
    const l = (await as('gv1').post('/staff/leaves', { fromDate: d1, toDate: addDays(d1, 1), reason: 'Việc gia đình' }).expect(201)).body;
    expect(l).toMatchObject({ status: 'pending', userId: s.users.gv1.id });
    expect((await as('gv1').post('/staff/leaves', { fromDate: addDays(d1, 1), toDate: addDays(d1, 1), reason: 'x' }).expect(409)).body.code).toBe('LEAVE_OVERLAP');
    expect((await as('admin').get('/notifications').expect(200)).body.items.some((n: any) => n.type === 'staff_leave')).toBe(true);
    await as('gv1').post(`/staff/leaves/${l.id}/approve`, {}).expect(403);
    expect((await as('admin').post(`/staff/leaves/${l.id}/reject`, {}).expect(400)).body.code).toBe('NOTE_REQUIRED');
    expect((await as('admin').post(`/staff/leaves/${l.id}/approve`, { note: 'OK' }).expect(200)).body).toMatchObject({ status: 'approved', decisionNote: 'OK' });
    expect((await as('admin').post(`/staff/leaves/${l.id}/approve`, {}).expect(409)).body.code).toBe('ALREADY_DECIDED');
    expect((await as('gv1').post(`/staff/leaves/${l.id}/cancel`, {}).expect(409)).body.code).toBe('ALREADY_DECIDED');
    expect((await as('gv1').get('/notifications').expect(200)).body.items.some((n: any) => n.type === 'staff_leave_decision')).toBe(true);
    const l2 = (await as('gv1').post('/staff/leaves', { fromDate: addDays(T, 20), toDate: addDays(T, 20), reason: 'Khám bệnh' }).expect(201)).body;
    await as('gv2').post(`/staff/leaves/${l2.id}/cancel`, {}).expect(403);
    expect((await as('gv1').post(`/staff/leaves/${l2.id}/cancel`, {}).expect(200)).body.status).toBe('cancelled');
    expect((await as('gv1').get('/staff/leaves').expect(200)).body.items.map((x: any) => x.status).sort()).toEqual(['approved', 'cancelled']);
    expect((await as('admin').get('/staff/leaves?status=approved').expect(200)).body.items.length).toBeGreaterThanOrEqual(2);
    const today = (await as('gv1').get('/staff/me/today').expect(200)).body;
    expect(today.leaves.map((x: any) => x.id)).toContain(l.id);
  });
});
