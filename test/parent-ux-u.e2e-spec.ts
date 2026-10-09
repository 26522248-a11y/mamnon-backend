process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-u-'));
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
import { AnnouncementsService } from '../src/notifications/announcements.service';

/** Parent UX round 4: U1 ping + self keep-alive, U4 one-tap absence (reason optional). */
describe('parent UX U1/U4 (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource, ids: Awaited<ReturnType<typeof seed>>;
  const tok: Record<string, string> = {};
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>()); await app.init(); http = app.getHttpServer();
    ds = app.get(DataSource); await ds.runMigrations(); ids = await seed(ds);
    for (const u of ['ph1', 'gv1']) tok[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });

  it('U1: GET /health/ping is public and tiny', async () => {
    const r = await request(http).get('/api/v1/health/ping').expect(200);
    expect(r.body).toMatchObject({ ok: true, uptime: expect.any(Number) });
  });

  it('U1: keep-alive ping fetches KEEPALIVE_URL and runs the announcement dispatch', async () => {
    const svc = app.get(AnnouncementsService);
    await new Promise<void>((r) => app.getHttpServer().listen(0, r));
    const port = (app.getHttpServer().address() as any).port;
    const spy = jest.spyOn(svc, 'runDue');
    const f = jest.spyOn(global, 'fetch');
    await svc.ping(`http://127.0.0.1:${port}/api/v1/health/ping`);
    expect(f).toHaveBeenCalledWith(`http://127.0.0.1:${port}/api/v1/health/ping`, expect.anything());
    expect((await f.mock.results[0].value).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    f.mockRestore(); spy.mockRestore();
  });

  it('U4: parent reports absence with no reason → 201, reason other; second tap → 409 ABSENCE_OVERLAP', async () => {
    let d = addDays(todayStr(), 1);
    while ([0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay())) d = addDays(d, 1);
    const kid = ids.kids[0].id;
    const r = await request(http).post(`/api/v1/children/${kid}/absences`).set('Authorization', `Bearer ${tok.ph1}`).send({ from: d }).expect(201);
    expect(r.body).toMatchObject({ reason: 'other', from: d });
    const again = await request(http).post(`/api/v1/children/${kid}/absences`).set('Authorization', `Bearer ${tok.ph1}`).send({ from: d }).expect(409);
    expect(again.body.code).toBe('ABSENCE_OVERLAP');
    await request(http).post(`/api/v1/children/${kid}/absences`).set('Authorization', `Bearer ${tok.ph1}`).send({ from: d, reason: 'bogus' }).expect(400);
  });
  it('U10: hand-over with photo → parents get "🚸 Bé X đã được đón" (who, time, teacher, photo, school phone); photo access; sms/zalo stubs', async () => {
    process.env.SCHOOL_PHONE = '0367842613';
    const prev = process.env.NOTIFY_CHANNELS; process.env.NOTIFY_CHANNELS = 'inapp,webpush,sms,zalo';
    const kid = ids.kids[0];
    await request(http).put(`/api/v1/classes/${kid.classId}/attendance`).set('Authorization', `Bearer ${tok.gv1}`)
      .send({ date: todayStr(), items: [{ childId: kid.id, status: 'present' }] }).expect((r) => expect([200, 201]).toContain(r.status));
    const att = (await ds.query(`SELECT id FROM attendance WHERE child_id = $1 AND date = $2`, [kid.id, todayStr()]))[0].id;
    const dad = (await ds.query(`SELECT id, full_name, relation FROM guardians WHERE child_id = $1 AND can_pickup ORDER BY created_at LIMIT 1`, [kid.id]))[0];
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#4DA3FF' } }).jpeg().toBuffer();
    await request(http).post(`/api/v1/attendance/${att}/pickup`).set('Authorization', `Bearer ${tok.gv1}`).field('guardianId', dad.id).attach('photo', Buffer.from('nope'), 'x.jpg').expect(400);
    const h = await request(http).post(`/api/v1/attendance/${att}/pickup`).set('Authorization', `Bearer ${tok.gv1}`).field('guardianId', dad.id).attach('photo', img, 'p.jpg').expect(201);
    expect(h.body).toMatchObject({ pickedUpByName: dad.full_name, photoUrl: `/api/v1/attendance/${att}/pickup-photo`, handedOverByName: expect.any(String) });
    const n = (await request(http).get('/api/v1/notifications').set('Authorization', `Bearer ${tok.ph1}`).expect(200)).body.items.find((x: any) => x.type === 'picked_up' && x.data?.attendanceId === att);
    expect(n.title).toBe(`🚸 Bé ${kid.fullName.split(' ').pop()} đã được đón`);
    expect(n.body).toMatch(new RegExp(`^${dad.relation} ${dad.full_name} đón lúc \\d\\d:\\d\\d, .+ giao\\.$`));
    expect(n.data).toMatchObject({ childId: kid.id, pickedUpByName: dad.full_name, relation: dad.relation, handedOverByName: h.body.handedOverByName,
      photoUrl: `/api/v1/attendance/${att}/pickup-photo`, schoolPhone: '0367842613', pickedUpAt: expect.any(String) });
    const ph = await request(http).get(`/api/v1/attendance/${att}/pickup-photo`).set('Authorization', `Bearer ${tok.ph1}`).expect(200);
    expect(ph.headers['content-type']).toMatch(/image\/jpeg/);
    const ph2 = (await request(http).post('/api/v1/auth/login').send({ username: 'ph2', password: '123456' })).body.accessToken;
    await request(http).get(`/api/v1/attendance/${att}/pickup-photo`).set('Authorization', `Bearer ${ph2}`).expect(404);
    const d = await ds.query(`SELECT channel, status FROM notification_deliveries WHERE type = 'picked_up' AND ref_id = $1`, [n.data.pickupId]);
    expect(d.filter((x: any) => x.channel === 'sms' || x.channel === 'zalo').every((x: any) => x.status === 'skipped')).toBe(true);
    expect(d.map((x: any) => x.channel)).toEqual(expect.arrayContaining(['sms', 'zalo']));
    process.env.NOTIFY_CHANNELS = prev;
  });
});
