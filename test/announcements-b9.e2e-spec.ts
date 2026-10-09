process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-b9-'));
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.CRON_SECRET = 'cron-test-secret-123';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { S3Storage, setStorage } from '../src/common/storage';
import { seed } from '../src/database/seed';
import { AnnouncementsService, vnIso } from '../src/notifications/announcements.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

/** B9: hẹn giờ gửi thông báo + ảnh đính kèm + bộ hẹn giờ + cron ngoài + lưu trữ S3. */
describe('B9 scheduled announcements + images (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource, svc: AnnouncementsService;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    del: (url: string) => request(http).delete('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    upload: (buf: Buffer, name = 'a.png') => request(http).post('/api/v1/announcements/attachments').set('Authorization', `Bearer ${tokens[who]}`).attach('file', buf, name),
  });
  const vnIn = (ms: number) => vnIso(new Date(Date.now() + ms))!;
  let png: Buffer;
  const notifCount = async (annId: string) => Number((await ds.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE announcement_id = $1`, [annId]))[0].n);
  const makeDue = (id: string) => ds.query(`UPDATE announcements SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [id]);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    svc = app.get(AnnouncementsService);
    await ds.runMigrations();
    await seed(ds);
    for (const u of ['admin', 'gv1', 'gv2', 'ketoan', 'ph1']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2EBF91' } }).png().toBuffer();
  });
  afterAll(async () => { setStorage(null); await app?.close(); });

  it('uploads: magic bytes, JPEG + 360px thumb, roles, max 6', async () => {
    const a = (await as('admin').upload(png).expect(201)).body;
    expect(a).toMatchObject({ width: 800, height: 600, size: expect.any(Number), url: expect.stringMatching(/^\/api\/v1\/announcements\/attachments\/.+$/), thumbUrl: expect.stringMatching(/\/thumb$/) });
    const t = await as('admin').get(a.thumbUrl.replace('/api/v1', '')).expect(200);
    expect(t.headers['content-type']).toMatch(/image\/jpeg/);
    expect((await sharp(t.body).metadata())).toMatchObject({ width: 360, height: 360, format: 'jpeg' });
    expect((await as('admin').upload(Buffer.from('not an image'), 'x.jpg').expect(400)).body.code).toBe('INVALID_FILE');
    await as('ph1').upload(png).expect(403);
    await as('ketoan').upload(png).expect(403);
    await as('gv2').get(a.url.replace('/api/v1', '')).expect(404); // not linked yet: uploader/admin only
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await as('admin').upload(png).expect(201)).body.id);
    await as('admin').post('/announcements', { title: 'X', body: 'Y', scope: 'school', attachmentIds: ids }).expect(400);
    const other = (await as('gv1').upload(png).expect(201)).body.id;
    expect((await as('admin').post('/announcements', { title: 'X', body: 'Y', scope: 'school', attachmentIds: [other] }).expect(400)).body.code).toBe('INVALID_ATTACHMENTS');
  });

  it('schedule: past/naive times rejected; hidden from parents until due; PATCH/cancel only while scheduled; scheduler sends exactly once', async () => {
    expect((await as('admin').post('/announcements', { title: 'Họp PH', body: 'b', scope: 'school', scheduledAt: vnIn(-60_000) }).expect(400)).body.code).toBe('SCHEDULE_IN_PAST');
    await as('admin').post('/announcements', { title: 'Họp PH', body: 'b', scope: 'school', scheduledAt: '2099-01-01T07:30:00' }).expect(400);
    const att = [(await as('admin').upload(png).expect(201)).body.id, (await as('admin').upload(png, 'b.png').expect(201)).body.id];
    const when = vnIn(2 * 3600_000);
    const a = (await as('admin').post('/announcements', { title: 'Họp phụ huynh', body: 'Thứ 7 lúc 8h', scope: 'school', scheduledAt: when, attachmentIds: att }).expect(201)).body;
    expect(a).toMatchObject({ status: 'scheduled', sentAt: null, canEdit: true, recipientCount: 0 });
    expect(a.scheduledAt).toMatch(/\+07:00$/);
    expect(new Date(a.scheduledAt).getTime()).toBe(new Date(when).getTime());
    expect(a.attachments.map((x: any) => x.id)).toEqual(att);
    expect(await notifCount(a.id)).toBe(0);
    expect((await as('ph1').get('/announcements').expect(200)).body.items.map((x: any) => x.id)).not.toContain(a.id);
    expect((await as('ph1').get('/announcements?status=scheduled').expect(200)).body.items).toHaveLength(0);
    expect((await as('admin').get('/announcements?status=scheduled').expect(200)).body.items.map((x: any) => x.id)).toContain(a.id);
    expect((await as('admin').get('/announcements').expect(200)).body.items.map((x: any) => x.id)).not.toContain(a.id);
    await as('ph1').get(`/announcements/attachments/${att[0]}/thumb`).expect(404);
    // edit while scheduled
    await as('gv1').patch(`/announcements/${a.id}`, { title: 'X' }).expect(403);
    await as('admin').patch(`/announcements/${a.id}`, { scheduledAt: vnIn(-5_000) }).expect(400);
    const p = (await as('admin').patch(`/announcements/${a.id}`, { title: 'Họp phụ huynh đầu năm', attachmentIds: [att[1]] }).expect(200)).body;
    expect(p).toMatchObject({ title: 'Họp phụ huynh đầu năm', status: 'scheduled' });
    expect(p.attachments.map((x: any) => x.id)).toEqual([att[1]]);
    await as('admin').get(`/announcements/attachments/${att[0]}`).expect(404); // removed one is deleted

    expect((await svc.runDue()).sent).not.toContain(a.id); // not due yet
    await makeDue(a.id);
    const [r1, r2] = await Promise.all([svc.runDue(), svc.runDue()]); // concurrent ticks (e.g. 2 instances / cron + interval)
    expect([...r1.sent, ...r2.sent].filter((id) => id === a.id)).toHaveLength(1);
    expect((await svc.runDue()).sent).not.toContain(a.id);
    const n = await notifCount(a.id);
    const [{ users }] = await ds.query(`SELECT COUNT(*)::int AS users FROM users WHERE is_active AND id <> (SELECT id FROM users WHERE username = 'admin')`);
    expect(n).toBe(Number(users));
    expect(Number((await ds.query(`SELECT COUNT(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.announcement_id = $1 AND u.username = 'ph1'`, [a.id]))[0].n)).toBe(1);
    const seen = (await as('ph1').get('/announcements').expect(200)).body.items.find((x: any) => x.id === a.id);
    expect(seen).toMatchObject({ status: 'sent', sentAt: expect.stringMatching(/\+07:00$/), attachments: [{ id: att[1], width: 800, height: 600 }] });
    expect((await as('ph1').get(`/announcements/attachments/${att[1]}/thumb`).expect(200)).headers['content-type']).toMatch(/jpeg/);
    expect((await as('admin').patch(`/announcements/${a.id}`, { title: 'late' }).expect(409)).body.code).toBe('NOT_SCHEDULED');
    expect((await as('admin').post(`/announcements/${a.id}/cancel`).expect(409)).body.code).toBe('NOT_SCHEDULED');
  });

  it('cancel (revoke) a scheduled one → never sent; teacher class announcement + parents only see sent', async () => {
    const c = (await as('admin').post('/announcements', { title: 'Huỷ', body: 'b', scope: 'school', scheduledAt: vnIn(3600_000) }).expect(201)).body;
    expect((await as('admin').post(`/announcements/${c.id}/cancel`).expect(200)).body).toMatchObject({ status: 'revoked', canEdit: false });
    await makeDue(c.id);
    expect((await svc.runDue()).sent).not.toContain(c.id);
    expect(await notifCount(c.id)).toBe(0);
    const classId = (await ds.query(`SELECT class_id FROM class_teachers ct JOIN users u ON u.id = ct.user_id WHERE u.username = 'gv1' LIMIT 1`))[0].class_id;
    const t = (await as('gv1').post('/announcements', { title: 'Dã ngoại', body: 'Mang nón', scope: 'class', classId, scheduledAt: vnIn(3600_000) }).expect(201)).body;
    expect((await as('gv2').get('/announcements?status=scheduled').expect(200)).body.items.map((x: any) => x.id)).not.toContain(t.id);
    expect((await as('gv1').get('/announcements?status=scheduled').expect(200)).body.items.map((x: any) => x.id)).toContain(t.id);
    // send now = immediate
    const now = (await as('gv1').post('/announcements', { title: 'Ngay', body: 'b', scope: 'class', classId }).expect(201)).body;
    expect(now).toMatchObject({ status: 'sent', scheduledAt: null });
    expect(await notifCount(now.id)).toBeGreaterThan(0);
  });

  it('external cron endpoint: secret required, dispatches due items idempotently', async () => {
    const c = (await as('admin').post('/announcements', { title: 'Cron', body: 'b', scope: 'school', scheduledAt: vnIn(3600_000) }).expect(201)).body;
    await makeDue(c.id);
    await request(http).post('/api/v1/internal/cron/announcements').expect(401);
    await request(http).post('/api/v1/internal/cron/announcements').set('X-Cron-Secret', 'wrong').expect(401);
    const r = (await request(http).post('/api/v1/internal/cron/announcements').set('X-Cron-Secret', 'cron-test-secret-123').expect(200)).body;
    expect(r).toMatchObject({ ok: true });
    expect(r.ids).toContain(c.id);
    expect((await request(http).post('/api/v1/internal/cron/announcements').set('X-Cron-Secret', 'cron-test-secret-123').expect(200)).body.ids).not.toContain(c.id);
  });

  it('S3 driver (mocked client): put/get/remove, missing key, env validation, used by uploads', async () => {
    const objects = new Map<string, { body: Buffer; type: string }>();
    const fake = { send: jest.fn(async (cmd: any) => {
      const name = cmd.constructor.name, { Bucket, Key } = cmd.input;
      expect(Bucket).toBe('mamnon-test');
      if (name === 'PutObjectCommand') { objects.set(Key, { body: cmd.input.Body, type: cmd.input.ContentType }); return {}; }
      if (name === 'GetObjectCommand') { const o = objects.get(Key); if (!o) throw Object.assign(new Error('nf'), { name: 'NoSuchKey' }); return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } }; }
      if (name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
      throw new Error('unexpected ' + name);
    }) };
    const s3 = new S3Storage('mamnon-test', fake, 'https://cdn.example.com/');
    await s3.put('a/b.jpg', Buffer.from('hi'), 'image/jpeg');
    expect((await s3.get('a/b.jpg'))!.toString()).toBe('hi');
    expect(await s3.get('nope.jpg')).toBeNull();
    expect(s3.publicUrl('a/b.jpg')).toBe('https://cdn.example.com/a/b.jpg');
    await s3.remove('a/b.jpg');
    expect(objects.size).toBe(0);
    await expect(s3.put('../etc/passwd', Buffer.from(''), 'x')).rejects.toThrow(/invalid storage key/);
    expect(() => S3Storage.fromEnv({ STORAGE_DRIVER: 's3', S3_BUCKET: 'b' } as any)).toThrow(/S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET/);
    expect(S3Storage.fromEnv({ S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', S3_BUCKET: 'b', S3_ACCESS_KEY: 'k', S3_SECRET: 's' } as any).driver).toBe('s3');

    setStorage(s3);
    const up = (await as('admin').upload(png).expect(201)).body;
    expect([...objects.keys()].sort()).toEqual([expect.stringMatching(/^announcements\/.+\.jpg$/), expect.stringMatching(/^announcements\/.+_thumb\.jpg$/)].sort());
    const img = await as('admin').get(up.url.replace('/api/v1', '')).expect(200);
    expect((await sharp(img.body).metadata()).width).toBe(800);
    await as('admin').del(`/announcements/attachments/${up.id}`).expect(204);
    expect(objects.size).toBe(0);
    setStorage(null);
  });
});
