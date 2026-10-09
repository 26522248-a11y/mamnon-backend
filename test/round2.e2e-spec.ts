process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.NOTIFY_CHANNELS = 'inapp';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr, viDayLabel } from '../src/common/dates';
import { seed } from '../src/database/seed';
import { refundEligibleFor } from '../src/absences/absences.service';
import { parentReported } from './helpers/absence';

const dow = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
/** first date >= d with the given weekday (1 = Monday … 5 = Friday) */
const nextDow = (d: string, w: number) => { let x = d; while (dow(x) !== w) x = addDays(x, 1); return x; };
const weekend = (d: string) => dow(d) === 0 || dow(d) === 6;

describe('round 2 batch 1: absences, cutoff, holidays (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const H = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set(H(who)),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(H(who)).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set(H(who)).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set(H(who)).send(body),
    del: (url: string, body?: any) => request(http).delete('/api/v1' + url).set(H(who)).send(body),
  });
  const notes = async (username: string, type: string) =>
    ds.query(`SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = $1 AND n.type = $2 ORDER BY n.created_at`, [username, type]);
  const att = async (childId: string, date: string) => (await ds.query(`SELECT * FROM attendance WHERE child_id = $1 AND date = $2`, [childId, date]))[0];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'gv2', 'ph1', 'ph2', 'ketoan']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
  });
  afterAll(async () => { delete process.env.ABSENCE_CUTOFF; await app?.close(); });

  it('config: /settings/school and /absences/config expose the cutoff', async () => {
    process.env.ABSENCE_CUTOFF = '07:45';
    expect((await request(http).get('/api/v1/settings/school').expect(200)).body).toMatchObject({ absenceCutoff: '07:45', latestPickupTime: '18:00', latestPickup: '18:00' });
    expect((await request(http).get('/api/v1/absences/config').expect(200)).body).toEqual({ cutoff: '07:45', latestPickup: '18:00' });
    process.env.ABSENCE_CUTOFF = 'nonsense';
    expect((await request(http).get('/api/v1/absences/config').expect(200)).body.cutoff).toBe('08:00');
    delete process.env.ABSENCE_CUTOFF;
  });

  it('cutoff boundary: strictly before 08:00:00 VN = refund; exactly 08:00:00 = no refund; future days always; past never', () => {
    const day = '2026-10-12';
    const at = (vn: string) => new Date(`${day}T${vn}+07:00`);
    expect(refundEligibleFor(day, day, at('07:59:59.999'))).toBe(true);
    expect(refundEligibleFor(day, day, at('08:00:00.000'))).toBe(false);
    expect(refundEligibleFor(day, day, at('08:00:01'))).toBe(false);
    expect(refundEligibleFor(day, day, at('00:00:00'))).toBe(true);
    expect(refundEligibleFor('2026-10-13', day, at('23:00:00'))).toBe(true);
    expect(refundEligibleFor('2026-10-11', day, at('06:00:00'))).toBe(false);
  });

  it('P14: notification dates read "Thứ Bảy 10/10" (Vietnamese weekday + dd/MM)', () => {
    expect(viDayLabel('2026-10-10')).toBe('Thứ Bảy 10/10');
    expect(viDayLabel('2026-10-11')).toBe('Chủ Nhật 11/10');
    expect(viDayLabel('2026-10-12')).toBe('Thứ Hai 12/10');
    expect(viDayLabel('2026-01-05')).toBe('Thứ Hai 05/01');
  });
  it('teacher-marked absence is never refundable (client notifiedInAdvance ignored)', async () => {
    const kid = s.kids[3].id, d = addDays(todayStr(), -1);
    await as('admin').put(`/classes/${s.classes.c1.id}/attendance`, { date: d, items: [{ childId: kid, status: 'present' }] }).expect(200);
    await as('admin').put(`/classes/${s.classes.c1.id}/attendance`, { date: d, items: [{ childId: kid, status: 'absent', notifiedInAdvance: true, absenceReason: 'sick' }] }).expect(200);
    expect(await att(kid, d)).toMatchObject({ status: 'absent', notified_in_advance: false, absence_reason: 'sick' });
  });

  it('P1 absence reason: missing = unchanged, null = clear, switch to present/plain absent clears; excused = parent report OR teacher reason; refund independent', async () => {
    const c1 = s.classes.c1.id, kid = s.kids[6].id, d = addDays(todayStr(), -1);
    const row = async (childId = kid, date = d) => (await as('admin').get(`/classes/${c1}/attendance?date=${date}`).expect(200)).body.items.find((x: any) => x.childId === childId);
    const put = (item: any, date = d) => as('admin').put(`/classes/${c1}/attendance`, { date, items: [{ childId: kid, ...item }] }).expect(200);
    await put({ status: 'absent', absenceReason: 'sick' });
    expect(await row()).toMatchObject({ status: 'absent', absenceReason: 'sick', excused: true, excusedBy: 'teacher', refundEligible: false, notifiedInAdvance: false });
    await put({ status: 'absent', note: 'gọi điện' }); // reason missing → unchanged
    expect(await row()).toMatchObject({ absenceReason: 'sick', excused: true, note: 'gọi điện' });
    await put({ status: 'absent', absenceReason: null }); // null → cleared
    expect(await row()).toMatchObject({ status: 'absent', absenceReason: null, excused: false, excusedBy: null });
    expect(await att(kid, d)).toMatchObject({ absence_reason: null });
    await put({ status: 'absent', absenceReason: 'family' });
    await put({ status: 'present' }); // switch to present clears
    expect(await row()).toMatchObject({ status: 'present', absenceReason: null, excused: false });
    await put({ status: 'absent' }); // switch to plain absent: no reason
    expect(await row()).toMatchObject({ status: 'absent', absenceReason: null, excused: false });
    await put({ status: 'late', absenceReason: 'other' }); // reason ignored unless absent
    expect(await row()).toMatchObject({ status: 'late', absenceReason: null });
    expect((await as('admin').put(`/classes/${c1}/attendance`, { date: d, items: [{ childId: kid, status: 'absent', absenceReason: 'bored' }] }).expect(400)).body.code).toBe('VALIDATION_ERROR');

    // parent report before cutoff: excused (by parent) + refundable, independent of the teacher's reason
    const k2 = s.kids[12].id, d2 = addDays(todayStr(), -2);
    await parentReported(ds, k2, [d2], 'sick');
    await as('admin').put(`/classes/${c1}/attendance`, { date: d2, items: [{ childId: k2, status: 'absent', absenceReason: null }] }).expect(200);
    expect(await row(k2, d2)).toMatchObject({ status: 'absent', absenceReason: null, excused: true, excusedBy: 'parent', refundEligible: true });
    await as('admin').put(`/classes/${c1}/attendance`, { date: d2, items: [{ childId: k2, status: 'absent', absenceReason: 'family' }] }).expect(200);
    expect(await row(k2, d2)).toMatchObject({ absenceReason: 'family', excused: true, excusedBy: 'parent', refundEligible: true });
  });

  it('multi-day report skips weekends, writes excused attendance, notifies teachers; access + validation; partial and full cancel with history', async () => {
    const kid = s.kids[0].id;
    const fri = nextDow(addDays(todayStr(), 8), 5), mon = addDays(fri, 3), tue = addDays(fri, 4);
    const r = await as('ph1').post(`/children/${kid}/absences`, { from: fri, to: tue, reason: 'sick', note: 'Sốt' }).expect(201);
    expect(r.body).toMatchObject({ childId: kid, childName: s.kids[0].fullName, className: 'Mầm 1', from: fri, to: tue, reason: 'sick', note: 'Sốt', status: 'active', cancelledAt: null });
    expect(r.body.days.map((d: any) => d.date)).toEqual([fri, mon, tue]);
    expect(r.body.days.every((d: any) => d.refundEligible && !d.overridden && !d.cancelled)).toBe(true);
    expect(r.body.skippedDates).toEqual([{ date: addDays(fri, 1), reason: 'WEEKEND' }, { date: addDays(fri, 2), reason: 'WEEKEND' }]);
    expect(r.body.cancellable).toEqual([fri, mon, tue]);
    expect(r.body.history).toEqual([expect.objectContaining({ action: 'created', dates: [fri, mon, tue], byName: expect.any(String), byRole: 'parent' })]);
    expect(await att(kid, mon)).toMatchObject({ status: 'absent', notified_in_advance: true, absence_reason: 'sick', absence_id: r.body.id });
    expect((await notes('gv1', 'absence_report')).length).toBe(1);
    expect((await notes('gv1', 'absence_report'))[0].title).toMatch(new RegExp(` – 3 ngày \\(${viDayLabel(fri)} → ${viDayLabel(tue)}\\)$`)); // P14
    expect((await notes('gv2', 'absence_report')).length).toBe(0);

    // access + validation
    await as('ph1').post(`/children/${s.kids[1].id}/absences`, { from: fri, reason: 'sick' }).expect(403);
    await as('gv1').post(`/children/${kid}/absences`, { from: fri, reason: 'sick' }).expect(403);
    expect((await as('ph1').post(`/children/${kid}/absences`, { from: addDays(todayStr(), -1), reason: 'sick' }).expect(400)).body.code).toBe('DATE_IN_PAST');
    expect((await as('ph1').post(`/children/${kid}/absences`, { from: fri, reason: 'bored' }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    expect((await as('ph1').post(`/children/${kid}/absences`, { from: tue, to: fri, reason: 'sick' }).expect(400)).body.code).toBe('INVALID_RANGE');
    expect((await as('ph1').post(`/children/${kid}/absences`, { from: addDays(fri, 1), to: addDays(fri, 2), reason: 'sick' }).expect(400)).body.code).toBe('NO_SCHOOL_DAYS');
    const ov = await as('ph1').post(`/children/${kid}/absences`, { from: mon, reason: 'family' }).expect(409);
    expect(ov.body).toMatchObject({ code: 'ABSENCE_OVERLAP', details: { dates: [mon] } });

    // history list: parent, class teacher, admin; other teacher 403
    expect((await as('ph1').get(`/children/${kid}/absences`).expect(200)).body.items).toHaveLength(1);
    expect((await as('gv1').get(`/children/${kid}/absences`).expect(200)).body.items[0].cancellable).toEqual([]);
    await as('gv2').get(`/children/${kid}/absences`).expect(403);
    await as('ph2').get(`/absences/${r.body.id}`).expect(403);

    // partial cancel (Monday)
    const c1 = await as('ph1').del(`/absences/${r.body.id}`, { dates: [mon] }).expect(200);
    expect(c1.body.status).toBe('partly_cancelled');
    expect(c1.body.days.find((d: any) => d.date === mon)).toMatchObject({ cancelled: true });
    expect(await att(kid, mon)).toBeUndefined();
    expect(await att(kid, fri)).toBeDefined();
    expect((await notes('gv1', 'absence_cancelled')).length).toBe(1);
    expect((await notes('gv1', 'absence_cancelled'))[0].title).toMatch(new RegExp(` – ${viDayLabel(mon)}$`)); // P14
    // the freed day can be reported again
    const again = await as('ph1').post(`/children/${kid}/absences`, { from: mon, reason: 'family' }).expect(201);
    await as('ph1').del(`/absences/${again.body.id}`).expect(200);
    // other parent cannot cancel
    await as('ph2').del(`/absences/${r.body.id}`).expect(403);
    // cancel the rest
    const c2 = await as('ph1').del(`/absences/${r.body.id}`).expect(200);
    expect(c2.body).toMatchObject({ status: 'cancelled', cancellable: [] });
    expect(c2.body.cancelledAt).toBeTruthy();
    expect(c2.body.history.map((h: any) => h.action)).toEqual(['created', 'cancelled', 'cancelled']);
    expect(await att(kid, fri)).toBeUndefined();
    expect((await notes('gv1', 'absence_cancelled')).map((n: any) => n.title)).toContainEqual(expect.stringMatching(new RegExp(` – ${viDayLabel(fri)}, ${viDayLabel(tue)}$`))); // P14: multi-date joined with ', '
    expect((await as('ph1').del(`/absences/${r.body.id}`).expect(409)).body.code).toBe('CANCEL_AFTER_CUTOFF');
  });

  it('today: before cutoff = refund + free cancel; after cutoff = no refund, no parent cancel; "all present" keeps excused; explicit override = no refund + kitchen notified', async () => {
    const kid = s.kids[0].id, today = todayStr(), c1 = s.classes.c1.id;
    if (weekend(today)) {
      expect((await as('ph1').post(`/children/${kid}/absences`, { from: today, reason: 'sick' }).expect(400)).body.code).toBe('NO_SCHOOL_DAYS');
      return;
    }
    process.env.ABSENCE_CUTOFF = '23:59'; // "now" is before the cutoff
    const a = await as('ph1').post(`/children/${kid}/absences`, { from: today, reason: 'sick' }).expect(201);
    expect(a.body.days).toEqual([expect.objectContaining({ date: today, refundEligible: true })]);
    expect(a.body.cancellable).toEqual([today]);
    expect((await notes('admin', 'kitchen_change')).length).toBe(1); // today's meal count changed
    expect((await notes('ketoan', 'kitchen_change')).length).toBe(1);
    await as('ph1').del(`/absences/${a.body.id}`).expect(200);
    expect(await att(kid, today)).toBeUndefined();

    process.env.ABSENCE_CUTOFF = '00:00'; // "now" is after the cutoff
    const b = await as('ph1').post(`/children/${kid}/absences`, { from: today, reason: 'family', note: 'Về quê' }).expect(201);
    expect(b.body.days[0]).toMatchObject({ refundEligible: false });
    expect(b.body.cancellable).toEqual([]);
    expect(await att(kid, today)).toMatchObject({ status: 'absent', notified_in_advance: false, absence_reason: 'family' });
    expect((await as('ph1').del(`/absences/${b.body.id}`).expect(409)).body).toMatchObject({ code: 'CANCEL_AFTER_CUTOFF', details: { dates: [today], cutoff: '00:00' } });

    // teacher sheet shows the excused absence
    const sheet = (await as('gv1').get(`/classes/${c1}/attendance?date=${today}`).expect(200)).body;
    expect(sheet.holiday).toBeNull();
    expect(sheet.items.find((x: any) => x.childId === kid)).toMatchObject({ status: 'absent', excused: true, absenceReason: 'family', absenceId: b.body.id, absenceNote: 'Về quê', refundEligible: false });

    // "Tất cả có mặt": every child present → the excused child is skipped
    const kids = sheet.items.map((x: any) => x.childId);
    const all = await as('gv1').put(`/classes/${c1}/attendance`, { date: today, items: kids.map((id: string) => ({ childId: id, status: 'present' })) }).expect(200);
    expect(all.body.skipped).toEqual([{ childId: kid, reason: 'EXCUSED_ABSENCE' }]);
    expect(all.body.items.find((x: any) => x.childId === kid)).toMatchObject({ status: 'absent', excused: true });
    // re-saving the sheet with the excused child as plain "absent" keeps it excused
    await as('gv1').put(`/classes/${c1}/attendance`, { date: today, items: [{ childId: kid, status: 'absent' }] }).expect(200);
    expect(await att(kid, today)).toMatchObject({ status: 'absent', absence_id: b.body.id, absence_reason: 'family' });

    // explicit override
    const kitchenBefore = (await notes('admin', 'kitchen_change')).length;
    const o = await as('gv1').put(`/classes/${c1}/attendance`, { date: today, items: [{ childId: kid, status: 'present', overrideAbsence: true }] }).expect(200);
    expect(o.body.skipped).toEqual([]);
    expect(o.body.items.find((x: any) => x.childId === kid)).toMatchObject({ status: 'present', excused: false, excusedOverridden: true, refundEligible: false });
    expect(await att(kid, today)).toMatchObject({ status: 'present', notified_in_advance: false });
    expect((await notes('admin', 'kitchen_change')).length).toBe(kitchenBefore + 1);
    expect((await notes('ketoan', 'kitchen_change')).length).toBe(kitchenBefore + 1);
    expect((await notes('ph1', 'absence_overridden')).length).toBe(1);
    // P14: notification date is "Thứ Bảy 10/10", not ISO
    expect((await notes('ph1', 'absence_overridden'))[0].title).toContain(`có mặt ${viDayLabel(today)} dù đã báo vắng`);
    const after = (await as('ph1').get(`/absences/${b.body.id}`).expect(200)).body;
    expect(after.days[0]).toMatchObject({ overridden: true, refundEligible: false });
    expect(after.history.map((h: any) => h.action)).toEqual(['created', 'overridden']);
    // generic absence reason on a normal absent mark
    const other = kids.find((id: string) => id !== kid);
    await as('gv1').put(`/classes/${c1}/attendance`, { date: today, items: [{ childId: other, status: 'absent', absenceReason: 'sick' }] }).expect(200);
    expect(await att(other, today)).toMatchObject({ absence_reason: 'sick', absence_id: null });
    process.env.ABSENCE_CUTOFF = '23:59';
    // a day the child is already present cannot be reported
    expect((await as('ph1').post(`/children/${kid}/absences`, { from: today, reason: 'sick' }).expect(400)).body).toMatchObject({ code: 'NO_SCHOOL_DAYS', details: { skippedDates: [{ date: today, reason: 'ALREADY_PRESENT' }] } });
    delete process.env.ABSENCE_CUTOFF;
  });

  it('holidays: admin CRUD, confirmed holiday blocks attendance + cancels reported days, pending has no effect until confirmed, national template', async () => {
    const kid = s.kids[0].id, c1 = s.classes.c1.id;
    const wed = nextDow(addDays(todayStr(), 22), 3), thu = addDays(wed, 1);
    // parent report covering Wed+Thu, then admin declares Wed a holiday → Wed cancelled + parent notified
    const r = await as('ph1').post(`/children/${kid}/absences`, { from: wed, to: thu, reason: 'family' }).expect(201);
    await as('ph1').post('/holidays', { date: wed, name: 'Nghỉ' }).expect(403);
    const h = await as('admin').post('/holidays', { date: wed, name: 'Ngày hội trường' }).expect(201);
    expect(h.body.items).toEqual([expect.objectContaining({ date: wed, name: 'Ngày hội trường', kind: 'school', status: 'confirmed', createdByName: expect.any(String) })]);
    const ab = (await as('ph1').get(`/absences/${r.body.id}`).expect(200)).body;
    expect(ab.days.map((d: any) => d.date)).toEqual([thu]); // holiday day hidden from history
    expect(ab.days[0]).toMatchObject({ cancelled: false, refundEligible: true, reportedAt: r.body.createdAt });
    expect(ab.status).toBe('partly_cancelled');
    const hist = (await as('ph1').get(`/children/${kid}/absences?from=${wed}&to=${thu}`).expect(200)).body.items;
    expect(hist.map((x: any) => x.id)).toEqual([r.body.id]);
    expect((await as('ph1').get(`/children/${kid}/absences?from=${addDays(thu, 1)}&to=${addDays(thu, 5)}`).expect(200)).body.items.map((x: any) => x.id)).not.toContain(r.body.id);
    expect(await att(kid, wed)).toBeUndefined();
    expect((await notes('ph1', 'absence_cancelled')).length).toBeGreaterThanOrEqual(1);
    expect((await notes('ph1', 'absence_cancelled')).map((n: any) => n.title)).toContain(`Trường nghỉ Ngày hội trường: báo vắng ${viDayLabel(wed)} không còn cần thiết`); // P14
    expect((await as('admin').post('/holidays', { date: wed, to: thu, name: 'x' }).expect(409)).body).toMatchObject({ code: 'HOLIDAY_EXISTS', details: { dates: [wed] } });
    // new reports skip the holiday
    await as('ph1').del(`/absences/${r.body.id}`).expect(200);
    const r2 = await as('ph1').post(`/children/${kid}/absences`, { from: wed, to: thu, reason: 'sick' }).expect(201);
    expect(r2.body.days.map((d: any) => d.date)).toEqual([thu]);
    expect(r2.body.skippedDates).toEqual([{ date: wed, reason: 'HOLIDAY' }]);
    // sheet shows "Trường nghỉ"
    expect((await as('gv1').get(`/classes/${c1}/attendance?date=${wed}`).expect(200)).body.holiday).toEqual({ id: h.body.items[0].id, name: 'Ngày hội trường' });
    // past holiday blocks PUT; a date with recorded attendance cannot become a holiday
    const past = addDays(todayStr(), -2);
    const hp = await as('admin').post('/holidays', { date: past, name: 'Mất điện' }).expect(201);
    expect((await as('admin').put(`/classes/${c1}/attendance`, { date: past, items: [{ childId: kid, status: 'present' }] }).expect(400)).body.code).toBe('SCHOOL_HOLIDAY');
    await as('admin').del(`/holidays/${hp.body.items[0].id}`).expect(204);
    await as('admin').put(`/classes/${c1}/attendance`, { date: past, items: [{ childId: kid, status: 'present' }] }).expect(200);
    expect((await as('admin').post('/holidays', { date: past, name: 'x' }).expect(409)).body.code).toBe('HOLIDAY_HAS_ATTENDANCE');
    // PATCH + list (any user)
    expect((await as('admin').patch(`/holidays/${h.body.items[0].id}`, { name: 'Hội trường', kind: 'school' }).expect(200)).body.name).toBe('Hội trường');
    expect((await as('ph1').get(`/holidays?from=${wed}&to=${wed}`).expect(200)).body.items).toHaveLength(1);

    // pending holiday has no effect until confirmed
    const fri = addDays(wed, 9);
    await ds.query(`INSERT INTO holidays (date, name, kind, status) VALUES ($1, 'Tết (chờ xác nhận)', 'national', 'pending')`, [fri]);
    const pr = await as('ph1').post(`/children/${kid}/absences`, { from: fri, reason: 'sick' }).expect(201);
    expect(pr.body.days.map((d: any) => d.date)).toEqual([fri]);
    expect((await as('gv1').get(`/classes/${c1}/attendance?date=${fri}`).expect(200)).body.holiday).toBeNull();
    const pend = (await as('admin').get(`/holidays?from=${fri}&to=${fri}&status=pending`).expect(200)).body.items;
    expect(pend).toEqual([expect.objectContaining({ status: 'pending', confirmedAt: null })]);
    const conf = await as('admin').post(`/holidays/${pend[0].id}/confirm`).expect(200);
    expect(conf.body).toMatchObject({ status: 'confirmed', confirmedBy: { id: s.users.admin.id, name: s.users.admin.name }, confirmedAt: expect.any(String) });
    expect((await as('ph1').get(`/absences/${pr.body.id}`).expect(200)).body.status).toBe('cancelled');
    expect((await as('gv1').get(`/classes/${c1}/attendance?date=${fri}`).expect(200)).body.holiday).toMatchObject({ name: 'Tết (chờ xác nhận)' });
  });

  it('national template: solar confirmed, lunar pending, idempotent, confirm per year', async () => {
    expect((await as('admin').post('/holidays/template', { year: 2031 }).expect(400)).body.code).toBe('TEMPLATE_YEAR_UNSUPPORTED');
    await as('ph1').post('/holidays/template', { year: 2027 }).expect(403);
    const dry = (await as('admin').post('/holidays/template', { year: 2027, dryRun: true }).expect(200)).body;
    expect(dry.items).toHaveLength(11);
    expect((await as('admin').get('/holidays?year=2027').expect(200)).body.items).toHaveLength(0);
    const t = (await as('admin').post('/holidays/template', { year: 2027 }).expect(200)).body;
    const by = Object.fromEntries(t.created.map((x: any) => [x.date, x.status]));
    expect(by).toMatchObject({ '2027-01-01': 'confirmed', '2027-04-30': 'confirmed', '2027-05-01': 'confirmed', '2027-09-02': 'confirmed',
      '2027-02-05': 'pending', '2027-02-06': 'pending', '2027-02-09': 'pending', '2027-04-16': 'pending' });
    expect(t.created.every((x: any) => x.kind === 'national')).toBe(true);
    expect((await as('admin').post('/holidays/template', { year: 2027 }).expect(200)).body).toMatchObject({ created: [], skipped: expect.arrayContaining([{ date: '2027-01-01', name: 'Tết Dương lịch' }]) });
    const c = (await as('admin').post('/holidays/confirm', { year: 2027 }).expect(200)).body;
    expect(c.confirmed).toHaveLength(6);
    expect((await as('admin').get('/holidays?year=2027&status=pending').expect(200)).body.items).toHaveLength(0);
  });

  it('dashboard does not flag unmarked classes on a confirmed holiday', async () => {
    const today = todayStr();
    const before = (await as('admin').get(`/dashboard/summary?date=${today}`).expect(200)).body.attention;
    expect(before.holiday).toBeNull();
    const existing = (await as('admin').get(`/holidays?from=${today}&to=${today}`).expect(200)).body.items;
    expect(existing).toHaveLength(0);
    // today has attendance recorded by earlier tests → create via DB to only test the dashboard reading
    await ds.query(`INSERT INTO holidays (date, name, status) VALUES ($1, 'Test', 'confirmed')`, [today]);
    const a = (await as('admin').get(`/dashboard/summary?date=${today}`).expect(200)).body.attention;
    expect(a.holiday).toMatchObject({ name: 'Test' });
    expect(a.classesNotMarked).toEqual([]);
    expect(a.classesPartlyMarked).toEqual([]);
    await ds.query(`DELETE FROM holidays WHERE date = $1`, [today]);
  });
});
