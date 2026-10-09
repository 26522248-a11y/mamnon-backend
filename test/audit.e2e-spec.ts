process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
const AUDIT_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.AUDIT_LOG_DIR = AUDIT_DIR;

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('audit_events (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    del: (url: string, body?: any) => request(http).delete('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    multipart: (url: string) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
  });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'ph1', 'ketoan']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });

  it('sensitive actions are stored in audit_events (and jsonl, marked persisted)', async () => {
    const kid = s.kids[0].id;
    // contact phones (parent)
    await as('ph1').patch(`/children/${kid}/contact-phones`, { phone1: '0977000001' }).expect(200);
    // authorized picker approve
    const p = await as('ph1').multipart(`/children/${kid}/authorized-pickers`).field('fullName', 'Trần Văn Tư').field('relation', 'Chú').field('idNumber', '079123456789').field('phone1', '0912345678')
      .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
    await as('admin').post(`/authorized-pickers/${p.body.id}/approve`, {}).expect(200);
    // CCCD full view
    const a = await request(http).put(`/api/v1/classes/${s.classes.c1.id}/attendance`).set('Authorization', `Bearer ${tokens.gv1}`)
      .send({ date: todayStr(), items: [{ childId: kid, status: 'present' }] }).expect(200);
    const attId = a.body.items.find((x: any) => x.childId === kid).attendanceId;
    await as('gv1').get(`/attendance/${attId}/pickup-identity?kind=authorized_picker&id=${p.body.id}`).expect(200);
    // guardian unlink
    const gs = (await as('admin').get(`/children/${kid}/guardians`).expect(200)).body;
    const grandma = gs.find((g: any) => g.relation === 'Bà nội');
    await as('admin').del(`/children/${kid}/guardians/${grandma.id}`, { reason: 'Gắn nhầm' }).expect(200);

    const rows = await ds.query(`SELECT action, entity_type, entity_id, child_id, actor_id, actor_role, before, after, reason, source FROM audit_events ORDER BY created_at`);
    expect(rows.map((r: any) => r.action)).toEqual(['child.contact_phones', 'authorized_picker.approve', 'pickup.identity_view', 'guardian.remove']);
    expect(rows[0]).toMatchObject({ entity_type: 'child', child_id: kid, actor_id: s.users.ph1.id, actor_role: 'parent', before: { phone1: expect.stringMatching(/^\+?\d{8,}$/) }, after: { phone1: '0977000001', phone2: null }, source: 'api' }); // B20: before = numbers in use (guardian phones)
    expect(rows[1]).toMatchObject({ entity_type: 'authorized_picker', entity_id: p.body.id, before: { status: 'pending' }, after: { status: 'approved', idNumber: '********6789' } });
    expect(rows[2]).toMatchObject({ entity_type: 'authorized_picker', entity_id: p.body.id, actor_role: 'teacher' });
    expect(rows[3]).toMatchObject({ entity_type: 'guardian', entity_id: grandma.id, reason: 'Gắn nhầm', before: { fullName: grandma.fullName } });
    expect(JSON.stringify(rows)).not.toContain('079123456789');
    const lines = fs.readFileSync(path.join(AUDIT_DIR, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.action, l.persisted])).toEqual(rows.map((r: any) => [r.action, true]));
  });

  it('GET /audit-events: admin only; filters (childId, action list/prefix, actor, date range) + paging', async () => {
    await as('gv1').get('/audit-events').expect(403);
    await as('ketoan').get('/audit-events').expect(403);
    await as('ph1').get('/audit-events').expect(403);
    await request(http).get('/api/v1/audit-events').expect(401);
    const all = (await as('admin').get('/audit-events').expect(200)).body;
    expect(all).toMatchObject({ total: 4, page: 1, limit: 50 });
    expect(all.items[0]).toMatchObject({ action: 'guardian.remove', actorUsername: 'admin', actorName: expect.any(String), childName: s.kids[0].fullName });
    expect((await as('admin').get(`/audit-events?childId=${s.kids[1].id}`).expect(200)).body.total).toBe(0);
    expect((await as('admin').get('/audit-events?action=authorized_picker.*,guardian.remove').expect(200)).body.items.map((x: any) => x.action)).toEqual(['guardian.remove', 'authorized_picker.approve']);
    expect((await as('admin').get('/audit-events?actor=ph1').expect(200)).body.total).toBe(1);
    expect((await as('admin').get(`/audit-events?actorId=${s.users.gv1.id}`).expect(200)).body.items[0].action).toBe('pickup.identity_view');
    expect((await as('admin').get(`/audit-events?from=${todayStr()}&to=${todayStr()}`).expect(200)).body.total).toBe(4);
    expect((await as('admin').get(`/audit-events?to=${addDays(todayStr(), -1)}`).expect(200)).body.total).toBe(0);
    const p2 = (await as('admin').get('/audit-events?limit=3&page=2').expect(200)).body;
    expect(p2).toMatchObject({ total: 4, page: 2, limit: 3 });
    expect(p2.items).toHaveLength(1);
    await as('admin').get('/audit-events?limit=500').expect(400);
    await as('admin').get('/audit-events?action=DROP TABLE').expect(400);
  });

  it('backfill: old jsonl entries imported once (persisted / invalid lines skipped), orphan CCCD views imported', async () => {
    const file = path.join(AUDIT_DIR, 'old.jsonl');
    const old = { at: '2026-10-09T12:35:46.575Z', action: 'guardian.remove', actorId: s.users.admin.id, actorUsername: 'admin',
      removed: { guardianId: '11111111-1111-4111-8111-111111111111', childId: s.kids[1].id, childName: 'x', fullName: 'QA Bà Hai', relation: 'Bà', phone: '0987000001', canPickup: false },
      account: null, reason: 'P0 hotfix' };
    fs.writeFileSync(file, [JSON.stringify(old), '{not json', JSON.stringify({ at: '2026-10-09T12:40:00Z', action: 'x.y', persisted: true, actorId: s.users.admin.id, entityType: 'child' })].join('\n') + '\n');
    await ds.query(`INSERT INTO sensitive_access_logs (user_id, user_role, entity_type, entity_id, child_id, field, purpose, ip) VALUES ($1, 'admin', 'guardian', $2, $3, 'id_number', 'handover', '1.2.3.4')`,
      [s.users.admin.id, '22222222-2222-4222-8222-222222222222', s.kids[1].id]);
    const run = (...args: string[]) => JSON.parse(execFileSync('npx', ['ts-node', '--transpile-only', 'src/database/backfill-audit.ts', `--file=${file}`, ...args],
      { cwd: path.join(__dirname, '..'), env: { ...process.env }, encoding: 'utf8' }).trim().split('\n').pop()!);
    const dry = run();
    expect(dry).toMatchObject({ mode: 'dry-run', jsonl: { lines: 3, skippedPersisted: 1, invalid: 1, candidates: 1 }, sensitive: { candidates: 1 }, inserted: 0 });
    expect(run('--apply')).toMatchObject({ mode: 'apply', inserted: 2 });
    expect(run('--apply')).toMatchObject({ inserted: 0 });
    const r = (await as('admin').get(`/audit-events?childId=${s.kids[1].id}`).expect(200)).body.items;
    expect(r.map((x: any) => [x.action, x.source])).toEqual([['pickup.identity_view', 'backfill_sensitive_log'], ['guardian.remove', 'backfill_jsonl']]);
    expect(r[1]).toMatchObject({ entityType: 'guardian', entityId: '11111111-1111-4111-8111-111111111111', reason: 'P0 hotfix', actorUsername: 'admin', before: { fullName: 'QA Bà Hai' }, createdAt: '2026-10-09T12:35:46.575Z' });
  }, 120000);
});
