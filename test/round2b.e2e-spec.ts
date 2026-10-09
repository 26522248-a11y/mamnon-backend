process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.NOTIFY_CHANNELS = 'inapp';

import * as ExcelJS from 'exceljs';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';
import { HolidayReminderService } from '../src/calendar/holiday-reminder.service';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dow = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
const weekend = (d: string) => dow(d) === 0 || dow(d) === 6;
const nextWeekday = (d: string) => { let x = d; while (weekend(x)) x = addDays(x, 1); return x; };
const prevWeekday = (d: string) => { let x = d; while (weekend(x)) x = addDays(x, -1); return x; };
const nextMonth = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

describe('round 2 batch 2/2b: medicine, late pickup, feed, notes, attention, photo consent, emergency closure, reminder (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const H = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set(H(who)),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(H(who)).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set(H(who)).send(body),
    del: (url: string, body?: any) => request(http).delete('/api/v1' + url).set(H(who)).send(body),
    multipart: (url: string) => request(http).post('/api/v1' + url).set(H(who)),
  });
  const notes = async (username: string, type: string) =>
    ds.query(`SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = $1 AND n.type = $2 ORDER BY n.created_at`, [username, type]);
  const today = todayStr();
  const schoolDay = !weekend(today);

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
  afterAll(async () => { delete process.env.MEDICINE_LATE_MINUTES; await app?.close(); });

  describe('medicines', () => {
    it('validation + access; multipart with photo; times variant', async () => {
      const kid = s.kids[0].id, d = nextWeekday(addDays(today, 1));
      const miss = await as('ph1').multipart(`/children/${kid}/medicines`).field('date', d).field('name', 'Siro').field('doses', '[{"time":"11:30"}]').expect(400);
      expect(miss.body.code).toBe('VALIDATION_ERROR'); // no dose
      expect((await as('ph1').post(`/children/${kid}/medicines`, { date: d, name: 'Siro', dose: '5 ml' }).expect(400)).body.code).toBe('VALIDATION_ERROR'); // no doses
      expect((await as('ph1').post(`/children/${kid}/medicines`, { date: d, name: 'Siro', dose: '5 ml', doses: [{ time: '25:00' }] }).expect(400)).body.code).toBe('VALIDATION_ERROR');
      expect((await as('ph1').post(`/children/${kid}/medicines`, { date: addDays(today, -1), name: 'Siro', dose: '5 ml', doses: [{ time: '08:30' }] }).expect(400)).body.code).toBe('DATE_IN_PAST');
      await as('ph1').post(`/children/${s.kids[1].id}/medicines`, { date: d, name: 'Siro', dose: '5 ml', doses: [{ time: '08:30' }] }).expect(403);
      await as('gv1').post(`/children/${kid}/medicines`, { date: d, name: 'Siro', dose: '5 ml', doses: [{ time: '08:30' }] }).expect(403);
      const r = await as('ph1').multipart(`/children/${kid}/medicines`).field('date', d).field('name', 'Siro ho').field('dose', '5 ml')
        .field('doses', JSON.stringify([{ time: '14:30', label: 'Sau ngủ trưa' }, { time: '08:30' }])).field('note', 'Lắc đều')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
      expect(r.body).toMatchObject({ childId: kid, className: 'Mầm 1', date: d, name: 'Siro ho', dose: '5 ml', note: 'Lắc đều', status: 'active', photoUrl: `/api/v1/medicines/${r.body.id}/photo` });
      expect(r.body.doses.map((x: any) => [x.time, x.label, x.givenAt])).toEqual([['08:30', null, null], ['14:30', 'Sau ngủ trưa', null]]);
      await as('gv1').get(`/medicines/${r.body.id}/photo`).expect(200);
      await as('gv2').get(`/medicines/${r.body.id}/photo`).expect(403);
      expect((await notes('gv1', 'medicine_request')).length).toBe(1);
      const t = await as('ph1').multipart(`/children/${kid}/medicines`).field('date', d).field('name', 'Vitamin').field('dose', '1 viên').field('times', '08:30').field('times', '15:30').expect(201);
      expect(t.body.doses.map((x: any) => x.time)).toEqual(['08:30', '15:30']);
      expect((await as('gv1').get(`/children/${kid}/medicines?date=${d}`).expect(200)).body.items).toHaveLength(2);
      await as('gv2').get(`/children/${kid}/medicines?date=${d}`).expect(403);
      // parent cancels (nothing given yet)
      expect((await as('ph1').del(`/medicines/${t.body.id}`).expect(200)).body.status).toBe('cancelled');
      // dose of a future day cannot be given yet
      expect((await as('gv1').post(`/medicine-doses/${r.body.doses[0].id}/given`, {}).expect(400)).body.code).toBe('NOT_TODAY');
    });

    it('mark dose given: teacher of class only, double mark 409, parent sees time + teacher, cannot cancel after; dashboard attention', async () => {
      if (!schoolDay) return;
      const kid = s.kids[0].id;
      process.env.MEDICINE_LATE_MINUTES = '0';
      const r = await as('ph1').post(`/children/${kid}/medicines`, { name: 'Hạ sốt', dose: '2.5 ml', doses: [{ time: '00:00' }, { time: '23:59' }] }).expect(201);
      expect(r.body.date).toBe(today);
      expect(r.body.doses.map((x: any) => x.late)).toEqual([true, false]);
      const att = (await as('admin').get(`/dashboard/summary?date=${today}`).expect(200)).body.attention;
      expect(att.medicinesNotGiven).toEqual([expect.objectContaining({ childId: kid, medicineName: 'Hạ sốt', time: '00:00', doseId: r.body.doses[0].id, className: 'Mầm 1' })]);
      expect(att.medicinesNotGivenCount).toBe(1);
      await as('gv2').post(`/medicine-doses/${r.body.doses[0].id}/given`, {}).expect(403);
      await as('ph1').post(`/medicine-doses/${r.body.doses[0].id}/given`, {}).expect(403);
      const g = await as('gv1').post(`/medicine-doses/${r.body.doses[0].id}/given`, { note: 'Bé uống hết' }).expect(200);
      expect(g.body.doses[0]).toMatchObject({ givenBy: s.users.gv1.id, givenByName: s.users.gv1.name, givenNote: 'Bé uống hết', late: false });
      expect(g.body.doses[0].givenAt).toBeTruthy();
      const dup = await as('admin').post(`/medicine-doses/${r.body.doses[0].id}/given`, {}).expect(409);
      expect(dup.body).toMatchObject({ code: 'ALREADY_GIVEN', details: { givenBy: s.users.gv1.id, givenByName: s.users.gv1.name } });
      const seen = (await as('ph1').get(`/children/${kid}/medicines`).expect(200)).body.items.find((m: any) => m.id === r.body.id);
      expect(seen.doses[0]).toMatchObject({ givenByName: s.users.gv1.name, givenAt: g.body.doses[0].givenAt });
      expect((await notes('ph1', 'medicine_given')).length).toBe(1);
      expect((await as('ph1').del(`/medicines/${r.body.id}`).expect(409)).body.code).toBe('DOSE_ALREADY_GIVEN');
      expect((await as('admin').get(`/dashboard/summary?date=${today}`).expect(200)).body.attention.medicinesNotGivenCount).toBe(0);
      // concurrent double mark: exactly one wins
      const r2 = await as('ph1').post(`/children/${kid}/medicines`, { name: 'Men', dose: '1 gói', doses: [{ time: '10:00' }] }).expect(201);
      const both = await Promise.all([as('gv1').post(`/medicine-doses/${r2.body.doses[0].id}/given`, {}), as('admin').post(`/medicine-doses/${r2.body.doses[0].id}/given`, {})]);
      expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
      delete process.env.MEDICINE_LATE_MINUTES;
    });
  });

  describe('late pickups + class feed', () => {
    it('rules, conflicts, cancel, feed', async () => {
      const kid = s.kids[0].id, d = nextWeekday(addDays(today, 9)), c1 = s.classes.c1.id; // own date: other tests use the next school day
      expect((await as('ph1').post(`/children/${kid}/late-pickups`, { date: d, time: '19:00' }).expect(400)).body.code).toBe('OUTSIDE_SCHOOL_HOURS');
      expect((await as('ph1').post(`/children/${kid}/late-pickups`, { date: d, time: '05:00' }).expect(400)).body.code).toBe('OUTSIDE_SCHOOL_HOURS');
      expect((await as('ph1').post(`/children/${kid}/late-pickups`, { date: d, time: '5pm' }).expect(400)).body.code).toBe('VALIDATION_ERROR');
      expect((await as('ph1').post(`/children/${kid}/late-pickups`, { date: addDays(today, -1), time: '17:00' }).expect(400)).body.code).toBe('DATE_IN_PAST');
      await as('ph2').post(`/children/${kid}/late-pickups`, { date: d, time: '17:30' }).expect(403);
      const sat = addDays(d, (6 - dow(d) + 7) % 7);
      expect((await as('ph1').post(`/children/${kid}/late-pickups`, { date: sat, time: '17:30' }).expect(400)).body.code).toBe('NOT_SCHOOL_DAY');
      const r = await as('ph1').post(`/children/${kid}/late-pickups`, { date: d, time: '17:45', pickerName: 'Bà ngoại', note: 'Bố mẹ đi công tác' }).expect(201);
      expect(r.body).toMatchObject({ childId: kid, date: d, time: '17:45', pickerName: 'Bà ngoại', status: 'active', className: 'Mầm 1' });
      expect((await as('ph1').post(`/children/${kid}/late-pickups`, { date: d, time: '17:30' }).expect(409)).body.code).toBe('LATE_PICKUP_EXISTS');
      expect((await notes('gv1', 'late_pickup')).length).toBe(1);
      expect((await as('gv1').get(`/children/${kid}/late-pickups`).expect(200)).body.items).toHaveLength(1);

      // feed
      const abs = await as('ph1').post(`/children/${s.kids[3].id}/absences`, { from: d, reason: 'sick' }).expect(403); // kids[3] not ph1's
      expect(abs.status).toBe(403);
      await as('admin').post(`/children/${s.kids[3].id}/absences`, { from: d, reason: 'sick', note: 'Sốt' }).expect(201);
      await as('ph1').post(`/children/${kid}/medicines`, { date: d, name: 'Siro', dose: '5 ml', doses: [{ time: '11:30' }] }).expect(201);
      const f = (await as('gv1').get(`/classes/${c1}/parent-messages?date=${d}`).expect(200)).body;
      expect(f).toMatchObject({ date: d, holiday: null, counts: { absences: 1, medicines: 1, dosesPending: 1, latePickups: 1 } });
      expect(f.absences[0]).toMatchObject({ childId: s.kids[3].id, reason: 'sick', note: 'Sốt' });
      expect(f.latePickups[0]).toMatchObject({ id: r.body.id, time: '17:45' });
      await as('gv2').get(`/classes/${c1}/parent-messages?date=${d}`).expect(403);
      await as('ph1').get(`/classes/${c1}/parent-messages?date=${d}`).expect(403);
      // cancel late pickup → gone from the feed, can re-send
      expect((await as('ph1').del(`/late-pickups/${r.body.id}`).expect(200)).body.status).toBe('cancelled');
      expect((await as('gv1').get(`/classes/${c1}/parent-messages?date=${d}`).expect(200)).body.counts.latePickups).toBe(0);
      await as('ph1').post(`/children/${kid}/late-pickups`, { date: d, time: '17:30' }).expect(201);
    });
  });

  it('daily notes: breakfast field (partial upsert), toilet', async () => {
    const c1 = s.classes.c1.id, kid = s.kids[0].id;
    const d = addDays(today, -1);
    await as('gv1').put(`/classes/${c1}/daily-notes`, { date: d, items: [{ childId: kid, breakfast: 'half', toilet: 'Tiêu chảy' }] }).expect(200);
    await as('gv1').put(`/classes/${c1}/daily-notes`, { date: d, items: [{ childId: kid, eating: 'all' }] }).expect(200);
    const row = (await as('gv1').get(`/classes/${c1}/daily-notes?date=${d}`).expect(200)).body.items.find((x: any) => x.childId === kid);
    expect(row).toMatchObject({ breakfast: 'half', eating: 'all', toilet: 'Tiêu chảy', photoConsent: false });
    expect((await as('gv1').put(`/classes/${c1}/daily-notes`, { date: d, items: [{ childId: kid, breakfast: 'lots' }] }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    const swagger = (await request(http).get('/api/docs-json')).body;
    if (swagger?.components) expect(swagger.components.schemas.DailyNoteItemDto.properties.breakfast).toBeDefined();
  });

  describe('photo consent', () => {
    it('default false; parent own only; history + audit; teacher read-only; roster badge', async () => {
      const kid = s.kids[0].id;
      const g = await as('ph1').get(`/children/${kid}/photo-consent`).expect(200);
      expect(g.body).toMatchObject({ childId: kid, consent: false, updatedBy: null, updatedAt: null, history: [] });
      await as('ph2').get(`/children/${kid}/photo-consent`).expect(403);
      await as('ph2').put(`/children/${kid}/photo-consent`, { consent: true }).expect(403);
      await as('gv1').get(`/children/${kid}/photo-consent`).expect(200);
      await as('gv1').put(`/children/${kid}/photo-consent`, { consent: true }).expect(403);
      await as('gv2').get(`/children/${kid}/photo-consent`).expect(403);
      await as('ketoan').get(`/children/${kid}/photo-consent`).expect(403);
      expect((await as('ph1').put(`/children/${kid}/photo-consent`, {}).expect(400)).body.code).toBe('VALIDATION_ERROR');
      const p = await as('ph1').put(`/children/${kid}/photo-consent`, { consent: true, note: 'Đồng ý đăng ảnh lớp' }).expect(200);
      expect(p.body).toMatchObject({ consent: true, updatedBy: { id: s.users.ph1.id, name: s.users.ph1.name } });
      expect(p.body.updatedAt).toBeTruthy();
      expect(p.body.history).toEqual([expect.objectContaining({ before: false, after: true, note: 'Đồng ý đăng ảnh lớp', by: expect.objectContaining({ id: s.users.ph1.id, role: 'parent' }) })]);
      await as('ph1').put(`/children/${kid}/photo-consent`, { consent: true }).expect(200); // unchanged → no new event
      await as('admin').put(`/children/${kid}/photo-consent`, { photoConsent: false, note: 'PH gọi điện rút lại' }).expect(200);
      const ev = (await as('admin').get(`/audit-events?childId=${kid}&action=child.photo_consent`).expect(200)).body;
      expect(ev.total).toBe(2);
      expect((await notes('gv1', 'photo_consent')).length).toBe(2);
      // roster badge: children list, attendance sheet, child detail
      await as('ph1').put(`/children/${kid}/photo-consent`, { consent: true }).expect(200);
      const list = (await as('gv1').get(`/children?classId=${s.classes.c1.id}&limit=100`).expect(200)).body.items;
      expect(list.find((x: any) => x.id === kid).photoConsent).toBe(true);
      expect(list.find((x: any) => x.id === s.kids[3].id).photoConsent).toBe(false);
      const sheet = (await as('gv1').get(`/classes/${s.classes.c1.id}/attendance?date=${today}`).expect(200)).body.items;
      expect(sheet.find((x: any) => x.childId === kid).photoConsent).toBe(true);
      expect((await as('ph1').get(`/children/${kid}`).expect(200)).body.photoConsent).toBe(true);
    });

    it('import column "Đồng ý chụp ảnh": Có → consent + audit (source import), blank → false, invalid → row error', async () => {
      const tpl = await as('admin').get('/imports/children/template').buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.body);
      const ws = wb.worksheets[0];
      const headers: string[] = []; ws.getRow(1).eachCell((c, i) => { headers[i] = String(c.value); });
      expect(headers).toContain('Đồng ý chụp ảnh');
      const col = (h: string) => headers.findIndex((x) => x && x.startsWith(h));
      const out = new ExcelJS.Workbook(); const o = out.addWorksheet('Danh sách');
      o.getRow(1).values = headers;
      const put = (r: number, v: Record<string, string>) => { for (const [h, val] of Object.entries(v)) o.getRow(r).getCell(col(h)).value = val; };
      put(2, { 'Họ tên bé': 'QA Ảnh Có', 'Ngày sinh': '01/02/2022', 'Giới tính': 'Nam', 'Lớp': 'Mầm 1', 'PH1 - Họ tên': 'QA PH Ảnh', 'PH1 - SĐT': '0966000101', 'Đồng ý chụp ảnh': 'Có' });
      put(3, { 'Họ tên bé': 'QA Ảnh Trống', 'Ngày sinh': '01/03/2022', 'Giới tính': 'Nữ', 'Lớp': 'Mầm 1', 'PH1 - Họ tên': 'QA PH Ảnh 2', 'PH1 - SĐT': '0966000102' });
      const buf = Buffer.from(await out.xlsx.writeBuffer());
      const bad = new ExcelJS.Workbook(); const b = bad.addWorksheet('x'); b.getRow(1).values = headers;
      for (const [h, val] of Object.entries({ 'Họ tên bé': 'QA Ảnh Sai', 'Ngày sinh': '01/02/2022', 'Giới tính': 'Nam', 'Lớp': 'Mầm 1', 'PH1 - Họ tên': 'X', 'PH1 - SĐT': '0966000103', 'Đồng ý chụp ảnh': 'Có lẽ' }))
        b.getRow(2).getCell(col(h)).value = val;
      const e = await as('admin').multipart('/imports/children?dryRun=true').attach('file', Buffer.from(await bad.xlsx.writeBuffer()), 'a.xlsx');
      expect(JSON.stringify(e.body)).toContain('Đồng ý chụp ảnh');
      await as('admin').multipart('/imports/children').attach('file', buf, 'a.xlsx').expect(200);
      const rows = await ds.query(`SELECT id, full_name, photo_consent FROM children WHERE full_name LIKE 'QA Ảnh%' ORDER BY full_name`);
      expect(rows.map((r: any) => [r.full_name, r.photo_consent])).toEqual([['QA Ảnh Có', true], ['QA Ảnh Trống', false]]);
      const ev = (await as('admin').get(`/children/${rows[0].id}/photo-consent`).expect(200)).body;
      expect(ev.history).toEqual([expect.objectContaining({ after: true, source: 'import' })]);
    });
  });

  describe('emergency closure', () => {
    it('dryRun counts; reason required; keeps attendance; refunds only children not present; audit; important push to all parents; banner', async () => {
      const P = prevWeekday(addDays(today, -1));
      const c1 = s.classes.c1.id;
      // make sure P has a mix: one present, one absent (not notified), rest unmarked
      await as('admin').put(`/classes/${c1}/attendance`, { date: P, items: [{ childId: s.kids[0].id, status: 'present' }, { childId: s.kids[3].id, status: 'absent' }] }).expect(200);
      expect((await as('admin').post('/holidays', { date: P, name: 'x' }).expect(409)).body.code).toBe('HOLIDAY_HAS_ATTENDANCE');
      expect((await as('admin').post('/holidays/emergency', { date: P }).expect(400)).body.code).toBe('VALIDATION_ERROR');
      expect((await as('admin').post('/holidays/emergency', { date: P, reason: '   ' }).expect(400)).body.code).toBe('VALIDATION_ERROR');
      await as('gv1').post('/holidays/emergency', { date: P, reason: 'x' }).expect(403);
      // a child withdrawn today (last day >= P, no parent account) must not be counted anywhere
      const gone = s.kids[29].id;
      await as('admin').post(`/children/${gone}/withdraw`, { leaveDate: today, reason: 'Chuyển trường' }).expect(200);
      const [{ present }] = await ds.query(`SELECT COUNT(*) FILTER (WHERE a.status IN ('present','late'))::int AS present FROM attendance a JOIN children c ON c.id = a.child_id WHERE a.date = $1 AND c.status = 'active'`, [P]);
      const dry = (await as('admin').post('/holidays/emergency', { date: P, reason: 'Mất điện', dryRun: true }).expect(201)).body;
      const [{ n: active, classed }] = await ds.query(`SELECT COUNT(*)::int n, COUNT(class_id)::int classed FROM children WHERE status = 'active'`);
      expect(dry).toMatchObject({ dryRun: true, childrenPresent: present, childrenTotal: active });
      expect(dry.childrenRefunded).toBe(classed - present);
      expect(dry.childrenWithoutParent.map((x: any) => x.childId)).not.toContain(gone);
      // total == dashboard's active-children total for that day; every number is active-only
      const dash = (await as('admin').get(`/dashboard/summary?date=${P}`).expect(200)).body;
      expect(dry.childrenTotal).toBe(dash.totalChildren);
      expect(dry.childrenPresent).toBe(dash.present + dash.late);
      expect(dry.childrenPresent + dry.childrenRefunded).toBeLessThanOrEqual(dash.totalChildren); // classless children get no attendance row
      expect(dry.parentsToNotify).toBeGreaterThanOrEqual(2);
      expect((await ds.query(`SELECT COUNT(*)::int n FROM holidays WHERE date = $1`, [P]))[0].n).toBe(0); // nothing written
      // children whose family has no parent account → must be phoned
      const [{ n: noAcc }] = await ds.query(`SELECT COUNT(*)::int n FROM children c WHERE c.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM guardians g JOIN users u ON u.id = g.user_id WHERE g.child_id = c.id AND u.is_active AND u.role = 'parent')`);
      expect(noAcc).toBeGreaterThan(0);
      expect(dry.childrenWithoutParentCount).toBe(noAcc);
      expect(dry.childrenWithoutParent).toHaveLength(noAcc);
      expect(dry.childrenWithoutParent[0]).toEqual({ childId: expect.any(String), name: expect.any(String), className: expect.any(String), phone1: expect.any(String) });
      const keys = dry.childrenWithoutParent.map((x: any) => `${x.className}|${x.name}`);
      expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
      expect(dry.childrenWithoutParent.map((x: any) => x.childId)).not.toContain(s.kids[0].id); // ph1's child has an account
      const [{ n: linkedParents }] = await ds.query(`SELECT COUNT(DISTINCT u.id)::int n FROM users u JOIN guardians g ON g.user_id = u.id JOIN children c ON c.id = g.child_id WHERE u.is_active AND u.role = 'parent' AND c.status = 'active'`);
      expect(dry.parentsToNotify).toBe(linkedParents);
      const before = await ds.query(`SELECT child_id, status, notified_in_advance, note FROM attendance WHERE date = $1 ORDER BY child_id`, [P]);
      const r = (await as('admin').post('/holidays/emergency', { date: P, reason: 'Mất điện toàn khu vực' }).expect(201)).body;
      expect(r.holiday).toMatchObject({ date: P, kind: 'emergency', status: 'confirmed', reason: 'Mất điện toàn khu vực', name: 'Nghỉ đột xuất' });
      expect(r).toMatchObject({ childrenPresent: dry.childrenPresent, childrenRefunded: dry.childrenRefunded, parentsNotified: dry.parentsToNotify });
      const after = await ds.query(`SELECT child_id, status, notified_in_advance, note FROM attendance WHERE date = $1 ORDER BY child_id`, [P]);
      for (const b0 of before) expect(after.find((a: any) => a.child_id === b0.child_id)).toEqual(b0); // existing rows unchanged
      expect(after.filter((a: any) => a.child_id !== gone)).toHaveLength(classed);
      expect(after.find((a: any) => a.child_id === gone)?.note ?? '').not.toContain('Trường nghỉ đột xuất'); // withdrawn child untouched
      expect(r.childrenWithoutParentCount).toBe(noAcc);
      expect((await as('admin').post('/holidays/emergency', { date: P, reason: 'again' }).expect(409)).body.code).toBe('HOLIDAY_EXISTS');
      // audit + push
      const ev = (await as('admin').get(`/audit-events?action=holiday.emergency`).expect(200)).body.items;
      expect(ev[0]).toMatchObject({ reason: 'Mất điện toàn khu vực', entityType: 'holiday', entityId: r.holiday.id });
      const pn = await notes('ph1', 'school_closure');
      expect(pn).toHaveLength(1);
      expect(pn[0]).toMatchObject({ important: true, body: 'Mất điện toàn khu vực' });
      // meal refund: next month's invoice refunds P for the absent child, not for the present one
      const period = nextMonth(today.slice(0, 7));
      await as('ketoan').post('/invoices/generate', { period, classId: c1 }).expect(201);
      const ddmm = `${P.slice(8, 10)}/${P.slice(5, 7)}`;
      const refundOf = async (childId: string) => {
        const i = (await as('ketoan').get(`/invoices?period=${period}&childId=${childId}`).expect(200)).body.items[0];
        const inv = (await as('ketoan').get(`/invoices/${i.id}`).expect(200)).body;
        return inv.lines.filter((l: any) => l.kind === 'refund' && l.description.includes(ddmm));
      };
      expect(await refundOf(s.kids[3].id)).toHaveLength(1);
      expect(await refundOf(s.kids[0].id)).toHaveLength(0);
      // attendance locked that day
      expect((await as('admin').put(`/classes/${c1}/attendance`, { date: P, items: [{ childId: s.kids[0].id, status: 'absent' }] }).expect(400)).body.code).toBe('SCHOOL_HOLIDAY');
    });

    it('banner: /settings/school exposes today\'s closure', async () => {
      expect((await request(http).get('/api/v1/settings/school').expect(200)).body.todayClosure).toBeNull();
      if (!schoolDay) return;
      await as('admin').post('/holidays/emergency', { date: today, reason: 'Ngập nước' }).expect(201);
      expect((await request(http).get('/api/v1/settings/school').expect(200)).body.todayClosure).toMatchObject({ date: today, kind: 'emergency', reason: 'Ngập nước' });
      await ds.query(`DELETE FROM holidays WHERE date = $1`, [today]);
    });
  });

  it('early-December holiday reminder: once per year, admins only, outside window no-op', async () => {
    const svc = app.get(HolidayReminderService);
    expect(await svc.run(new Date('2026-11-30T03:00:00Z'))).toMatchObject({ sent: false, reason: 'NOT_IN_WINDOW' });
    const r = await svc.run(new Date('2026-12-02T03:00:00Z'));
    expect(r).toMatchObject({ sent: true, year: 2027, admins: 1 });
    expect(await svc.run(new Date('2026-12-03T03:00:00Z'))).toMatchObject({ sent: false, reason: 'ALREADY_SENT' });
    expect(await svc.run(new Date('2026-12-10T03:00:00Z'))).toMatchObject({ sent: false, reason: 'NOT_IN_WINDOW' });
    const n = await notes('admin', 'holiday_reminder');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ important: true, title: 'Chốt lịch nghỉ năm 2027' });
    expect((await notes('ph1', 'holiday_reminder')).length).toBe(0);
    await as('ph1').post('/holidays/reminder', { force: true }).expect(403);
    expect((await as('admin').post('/holidays/reminder', { force: true }).expect(200)).body.sent).toBe(true);
  });

  it('duty roster audit: assign/remove record full before/after', async () => {
    const d1 = addDays(today, 20), d2 = addDays(today, 21);
    await as('admin').post('/pickup-duties', { userId: s.users.gv2.id, dates: [d1] }).expect(201);
    const r = await as('admin').post('/pickup-duties', { userId: s.users.gv2.id, dates: [d1, d2], note: 'Thay cô Lan' }).expect(201);
    const ev = (await as('admin').get(`/audit-events?action=pickup_duty.assign&entityId=${s.users.gv2.id}`).expect(200)).body.items[0];
    expect(ev.before).toMatchObject({ userId: s.users.gv2.id, username: 'gv2', dates: [d1] });
    expect(ev.after).toMatchObject({ userId: s.users.gv2.id, username: 'gv2', dates: [d1, d2], added: [d2], note: 'Thay cô Lan' });
    expect(ev.after.roster).toEqual(expect.arrayContaining([{ date: d2, userId: s.users.gv2.id, username: 'gv2' }]));
    const id = r.body.find((x: any) => x.date === d2).id;
    await as('admin').del(`/pickup-duties/${id}`).expect(204);
    const rm = (await as('admin').get(`/audit-events?action=pickup_duty.remove&entityId=${id}`).expect(200)).body.items[0];
    expect(rm.before).toMatchObject({ id, userId: s.users.gv2.id, username: 'gv2', date: d2, note: 'Thay cô Lan' });
    expect(rm.after).toBeNull();
  });

  it('mustChangePassword blocks the new endpoints', async () => {
    await ds.query(`UPDATE users SET must_change_password = true WHERE username = 'ph2'`);
    const r = await as('ph2').get(`/children/${s.kids[1].id}/photo-consent`).expect(403);
    expect(r.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await ds.query(`UPDATE users SET must_change_password = false WHERE username = 'ph2'`);
  });
});
