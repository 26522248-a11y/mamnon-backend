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
import { maskPhone, maskPhones, csvCell } from '../src/audit/sensitive';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';

/** B18 – Lịch sử thay đổi nhạy cảm: GET /audit/sensitive (+ /export CSV), admin only, read-only, phones masked. */
describe('B18 sensitive-change history (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    del: (url: string, body?: any) => request(http).delete('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
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

  it('masking helpers', () => {
    expect(maskPhone('0912345456')).toBe('0912 *** 456');
    expect(maskPhone('+84 912 345 456')).toBe('+8491 *** 456');
    expect(maskPhone('12345')).toBe('***');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhones({ phone1: '0977000001', phone2: null, fullName: 'A', nested: { phone: '0901234567' } }))
      .toEqual({ phone1: '0977 *** 001', phone2: null, fullName: 'A', nested: { phone: '0901 *** 567' } });
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('the three kinds of change write rows; list is typed, labelled, masked, newest first', async () => {
    const kid = s.kids[0];
    await as('ph1').patch(`/children/${kid.id}/contact-phones`, { phone1: '0977000001', phone2: '0988000002' }).expect(200);
    const was = (await as('admin').get(`/children/${kid.id}/photo-consent`).expect(200)).body.consent;
    await as('admin').put(`/children/${kid.id}/photo-consent`, { consent: !was, note: 'PH gọi điện' }).expect(200);
    await as('admin').patch(`/users/${s.users.gv1.id}`, { phone: '0901234567' }).expect(200);
    await as('admin').patch(`/users/${s.users.gv1.id}`, { name: 'Cô Lan' }).expect(200); // no phone change → no row
    const grandma = (await as('admin').get(`/children/${kid.id}/guardians`).expect(200)).body.find((g: any) => g.relation === 'Bà nội');
    await as('admin').del(`/children/${kid.id}/guardians/${grandma.id}`, { reason: 'Gắn nhầm' }).expect(200);
    // unrelated audited action must not show up
    await ds.query(`INSERT INTO audit_events (actor_id, actor_username, action, entity_type) VALUES ($1, 'admin', 'pickup.identity_view', 'guardian')`, [s.users.admin.id]);

    const r = (await as('admin').get('/audit/sensitive').expect(200)).body;
    expect(r).toMatchObject({ total: 4, page: 1, limit: 20, counts: { all: 4, guardian_unlink: 1, phone_change: 2, photo_consent: 1 } });
    expect(r.items.map((i: any) => i.type)).toEqual(['guardian_unlink', 'phone_change', 'photo_consent', 'phone_change']);
    const [unlink, userPhone, consent, contact] = r.items;
    expect(unlink).toMatchObject({
      action: 'guardian.remove', reason: 'Gắn nhầm', afterText: 'Đã gỡ',
      target: { entity: 'guardian', id: grandma.id, childId: kid.id, label: expect.stringContaining(kid.fullName) },
      actor: { id: s.users.admin.id, username: 'admin', role: 'admin', name: expect.any(String) }, ip: expect.any(String),
    });
    expect(unlink.target.label).toContain(' · '); // child · class
    expect(unlink.beforeText).toContain(grandma.fullName);
    expect(userPhone).toMatchObject({ action: 'user.phone', target: { entity: 'user', id: s.users.gv1.id }, after: { phone: '0901 *** 567' }, afterText: '0901 *** 567' });
    expect(consent).toMatchObject({ reason: 'PH gọi điện', before: { consent: was }, after: { consent: !was } });
    expect(contact).toMatchObject({ action: 'child.contact_phones', after: { phone1: '0977 *** 001', phone2: '0988 *** 002' },
      afterText: '0977 *** 001 / 0988 *** 002', actor: { username: 'ph1', role: 'parent', self: true }, createdAt: expect.any(String) });
    const json = JSON.stringify(r);
    for (const full of ['0977000001', '0988000002', '0901234567', grandma.phone].filter(Boolean)) expect(json).not.toContain(full);
  });

  it('filters: type (one / many), date range, search, paging; bad params → 400', async () => {
    const t = todayStr();
    expect((await as('admin').get('/audit/sensitive?type=phone_change').expect(200)).body).toMatchObject({ total: 2, counts: { all: 4 } });
    expect((await as('admin').get('/audit/sensitive?type=guardian_unlink,photo_consent').expect(200)).body.total).toBe(2);
    expect((await as('admin').get(`/audit/sensitive?from=${t}&to=${t}`).expect(200)).body.total).toBe(4);
    const empty = (await as('admin').get(`/audit/sensitive?to=${addDays(t, -1)}`).expect(200)).body;
    expect(empty).toMatchObject({ total: 0, items: [], counts: { all: 0 } });
    expect((await as('admin').get(`/audit/sensitive?q=${encodeURIComponent('cô lan')}`).expect(200)).body.items.map((i: any) => i.action)).toEqual(['user.phone']);
    const p2 = (await as('admin').get('/audit/sensitive?limit=3&page=2').expect(200)).body;
    expect(p2).toMatchObject({ total: 4, page: 2, limit: 3 });
    expect(p2.items).toHaveLength(1);
    await as('admin').get('/audit/sensitive?type=pickup').expect(400);
    await as('admin').get('/audit/sensitive?limit=500').expect(400);
    await as('admin').get('/audit/sensitive?from=hôm-qua').expect(400);
  });

  it('admin only and read-only', async () => {
    for (const who of ['gv1', 'ketoan', 'ph1']) {
      await as(who).get('/audit/sensitive').expect(403);
      await as(who).get('/audit/sensitive/export').expect(403);
    }
    await request(http).get('/api/v1/audit/sensitive').expect(401);
    await as('admin').post('/audit/sensitive', {}).expect(404);
    await as('admin').del('/audit/sensitive').expect(404);
    await as('admin').patch('/audit/sensitive', {}).expect(404);
  });

  it('CSV export: BOM, header, same filters, masked phones', async () => {
    const r = await as('admin').get('/audit/sensitive/export?type=phone_change').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    }).expect(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="lich-su-thay-doi_.*\.csv"/);
    const text: string = r.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('"Thời gian","Loại","Đối tượng","Trước","Sau","Lý do","Người sửa","Tên đăng nhập","Vai trò","IP"');
    expect(lines).toHaveLength(3);
    expect(text).toContain('0977 *** 001');
    expect(text).not.toContain('0977000001');
    expect(text).not.toContain('0901234567');
  });
});
