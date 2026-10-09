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
import { seed } from '../src/database/seed';

/** A1: posting class photos with a non-consenting child is blocked server-side unless the child is hidden. A2: first answer recorded, history "Chưa hỏi → …". */
describe('Photos A1 / consent A2 (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource, s: Awaited<ReturnType<typeof seed>>;
  const tok: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  let jpg: Buffer, an: any, other: any;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>()); await app.init(); http = app.getHttpServer();
    ds = app.get(DataSource); await ds.runMigrations(); s = await seed(ds);
    for (const u of ['admin', 'gv1', 'gv2', 'ph1', 'ph2']) tok[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    jpg = await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: '#88cc99' } }).jpeg().toBuffer();
    an = s.kids[0]; // ph1's child, class c1
    other = s.kids.find((k) => k.classId === s.classes.c1.id && k.id !== an.id)!;
    await ds.query(`UPDATE children SET photo_consent = false, photo_consent_updated_at = NULL WHERE class_id = $1`, [s.classes.c1.id]);
    await ds.query(`UPDATE children SET photo_consent = true, photo_consent_updated_at = now() WHERE id = $1`, [other.id]);
  });
  afterAll(async () => { await app?.close(); });

  const upload = (who: string, files: number, tags: string[][], extra: Record<string, unknown> = {}) => {
    let r = request(http).post(`/api/v1/classes/${s.classes.c1.id}/photo-posts`).set(auth(who)).field('caption', 'Vẽ tranh')
      .field('tags', JSON.stringify(tags)).field('clientIds', JSON.stringify(tags.map((_, i) => `c-${Date.now()}-${i}-${Math.random()}`)));
    for (const [k, v] of Object.entries(extra)) r = r.field(k, JSON.stringify(v));
    for (let i = 0; i < files; i++) r = r.attach('files', jpg, { filename: `a${i}.jpg`, contentType: 'image/jpeg' });
    return r;
  };

  it('A2: first answer recorded (also "Không"), asked flag, history Chưa hỏi → Không → Có', async () => {
    const g0 = (await request(http).get(`/api/v1/children/${an.id}/photo-consent`).set(auth('ph1')).expect(200)).body;
    expect(g0).toMatchObject({ consent: false, asked: false });
    const r1 = (await request(http).put(`/api/v1/children/${an.id}/photo-consent`).set(auth('ph1')).send({ consent: false }).expect(200)).body;
    expect(r1).toMatchObject({ consent: false, asked: true });
    await request(http).put(`/api/v1/children/${an.id}/photo-consent`).set(auth('ph1')).send({ consent: false }).expect(200); // same value again: no new row
    await request(http).put(`/api/v1/children/${an.id}/photo-consent`).set(auth('ph2')).send({ consent: true }).expect(403);
    const h = (await request(http).get('/api/v1/audit/sensitive?type=photo_consent').set(auth('admin')).expect(200)).body.items.filter((i: any) => i.childId === an.id || i.child?.id === an.id || JSON.stringify(i).includes(an.id));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ beforeText: 'Chưa hỏi', afterText: 'Không' });
  });

  it('A1: teacher sees who has not consented; tagged photo without consent rejected by API with clear error', async () => {
    const sum = (await request(http).get(`/api/v1/classes/${s.classes.c1.id}/photo-consent-summary`).set(auth('gv1')).expect(200)).body;
    expect(sum.notAllowed.map((k: any) => k.childId)).toContain(an.id);
    expect(sum.notAllowed.map((k: any) => k.childId)).not.toContain(other.id);
    await request(http).get(`/api/v1/classes/${s.classes.c1.id}/photo-consent-summary`).set(auth('gv2')).expect(403);
    const all = await upload('gv1', 1, [[an.id]]).expect(422);
    expect(all.body.code).toBe('PHOTO_CONSENT_MISSING');
    expect(all.body.message).toContain('chưa cho đăng hình');
    expect(all.body.details.children).toEqual([{ childId: an.id, name: an.fullName }]);
    expect(await ds.query('SELECT 1 FROM photos')).toHaveLength(0);
    // mixed: ok photo saved, blocked photo reported per photo
    const mixed = (await upload('gv1', 2, [[other.id], [an.id, other.id]]).expect(201)).body;
    expect(mixed.results.map((r: any) => r.status)).toEqual(['created', 'rejected']);
    expect(mixed.results[1]).toMatchObject({ code: 'PHOTO_CONSENT_MISSING', children: [{ childId: an.id }] });
    expect(mixed.photos).toHaveLength(1);
    // tagging later is also checked
    await request(http).put(`/api/v1/photos/${mixed.photos[0].id}/tags`).set(auth('gv1')).send({ childIds: [other.id, an.id] }).expect(422);
  });

  it('A1: "Ẩn bé" (hiddenForChildIds) posts the photo hidden; parents never see it; unhide only after consent', async () => {
    const r = (await upload('gv1', 1, [[an.id]], { hiddenForChildIds: [[an.id]] }).expect(201)).body;
    expect(r.results[0]).toMatchObject({ status: 'created', hidden: true });
    const pid = r.results[0].photoId;
    const ph = (await request(http).get(`/api/v1/classes/${s.classes.c1.id}/photo-posts`).set(auth('ph1')).expect(200)).body;
    expect(JSON.stringify(ph)).not.toContain(pid);
    await request(http).get(`/api/v1/photos/${pid}/file`).set(auth('ph1')).expect(404);
    const t = (await request(http).get(`/api/v1/classes/${s.classes.c1.id}/photo-posts`).set(auth('gv1')).expect(200)).body;
    const tp = t.items.flatMap((p: any) => p.photos).find((p: any) => p.id === pid);
    expect(tp).toMatchObject({ hidden: true, hiddenReason: 'CONSENT_MISSING', hiddenForChildIds: [an.id] });
    expect((await request(http).post(`/api/v1/photos/${pid}/unhide`).set(auth('gv1')).expect(422)).body.code).toBe('PHOTO_CONSENT_MISSING');
    await request(http).put(`/api/v1/children/${an.id}/photo-consent`).set(auth('ph1')).send({ consent: true }).expect(200);
    await request(http).post(`/api/v1/photos/${pid}/unhide`).set(auth('gv1')).expect(200);
    const f = await request(http).get(`/api/v1/photos/${pid}/file?download=1`).set(auth('ph1')).expect(200);
    expect(f.headers['content-type']).toBe('image/jpeg');
    // consent withdrawn -> auto hidden again, teachers notified
    const off = (await request(http).put(`/api/v1/children/${an.id}/photo-consent`).set(auth('ph1')).send({ consent: false }).expect(200)).body;
    expect(off.hiddenPhotos).toBe(1);
    await request(http).get(`/api/v1/photos/${pid}/file`).set(auth('ph1')).expect(404);
    const n = (await request(http).get('/api/v1/notifications?limit=50').set(auth('gv1')).expect(200)).body.items;
    expect(n.some((x: any) => x.type === 'photo_hidden')).toBe(true);
  });

  it('access: other class teacher / parent cannot post or view; non-image rejected', async () => {
    await upload('gv2', 1, [[]]).expect(403);
    const ph2kid = s.kids[1]; // ph2's child is in another class
    if (ph2kid.classId !== s.classes.c1.id) await request(http).get(`/api/v1/classes/${s.classes.c1.id}/photo-posts`).set(auth('ph2')).expect(403);
    const bad = await request(http).post(`/api/v1/classes/${s.classes.c1.id}/photo-posts`).set(auth('gv1')).field('tags', '[[]]')
      .attach('files', Buffer.from('not an image'), { filename: 'x.jpg', contentType: 'image/jpeg' }).expect(400);
    expect(bad.body.code).toBe('UNSUPPORTED_IMAGE');
  });
});
