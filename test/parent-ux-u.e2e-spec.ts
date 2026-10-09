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
});
