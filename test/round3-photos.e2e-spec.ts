process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-photos-'));
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.NOTIFY_CHANNELS = 'inapp';

import * as fs from 'fs';
import * as path from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { seed } from '../src/database/seed';

const fx = (n: string) => fs.readFileSync(`/workspace/qa/heic/${n}`);
const binParser = (res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };

describe('round 3: class photo album (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const H = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set(H(who)),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(H(who)).send(body),
    put: (url: string, body?: any) => request(http).put('/api/v1' + url).set(H(who)).send(body),
    del: (url: string) => request(http).delete('/api/v1' + url).set(H(who)),
    multipart: (url: string) => request(http).post('/api/v1' + url).set(H(who)),
  });
  const file = (who: string, id: string, qs = '') => as(who).get(`/photos/${id}/file${qs}`).buffer(true).parse(binParser);
  const notes = async (username: string, type: string) =>
    ds.query(`SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = $1 AND n.type = $2 ORDER BY n.created_at`, [username, type]);
  const audits = (action: string, entityId: string) => ds.query(`SELECT * FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY created_at`, [action, entityId]);
  const consent = (who: string, childId: string, v: boolean) => as(who).put(`/children/${childId}/photo-consent`, { consent: v }).expect(200);
  let c1: string, k: string[];
  let JPG: Buffer, PNG: Buffer, WEBP: Buffer;
  const post = (who: string, files: [Buffer, string][], tags?: string[][], caption = 'Vẽ tranh mùa thu') => {
    let r = as(who).multipart(`/classes/${c1}/photo-posts`).field('caption', caption);
    if (tags) r = r.field('tags', JSON.stringify(tags));
    for (const [b, n] of files) r = r.attach('files', b, n);
    return r;
  };
  let p0: string, p1: string, p2: string, postId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'gv2', 'ph1', 'ph2', 'ketoan']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    c1 = s.classes.c1.id;
    k = s.kids.map((x: any) => x.id);
    await ds.query(`UPDATE children SET photo_consent = false`);
    JPG = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).jpeg()
      .withExif({ IFD0: { Artist: 'GPS-TEST' }, IFD3: { GPSLatitudeRef: 'N' } }).withMetadata({ orientation: 6 }).toBuffer();
    PNG = await sharp({ create: { width: 30, height: 30, channels: 4, background: '#00ff00' } }).png().toBuffer();
    WEBP = await sharp({ create: { width: 30, height: 30, channels: 3, background: 'blue' } }).webp().toBuffer();
  });
  afterAll(async () => { await app?.close(); });

  it('ALB-06: only teachers of the class (or admin) post', async () => {
    await post('gv2', [[JPG, 'a.jpg']]).expect(403);
    await post('ph1', [[JPG, 'a.jpg']]).expect(403);
    await post('ketoan', [[JPG, 'a.jpg']]).expect(403);
    expect((await post('gv1', []).expect(400)).body.code).toBe('VALIDATION_ERROR');
  });

  it('ALB-01/08: tagging a child without consent → 422 with names, nothing saved', async () => {
    const r = (await post('gv1', [[JPG, 'a.jpg'], [PNG, 'b.png']], [[k[3]], [k[6], k[3]]]).expect(422)).body;
    expect(r.code).toBe('PHOTO_CONSENT_MISSING');
    const names = await ds.query(`SELECT id AS "childId", full_name AS name FROM children WHERE id = ANY($1) ORDER BY full_name`, [[k[3], k[6]]]);
    expect(r.details.children).toEqual(names);
    expect(r.message).toContain(names[0].name);
    expect((await ds.query(`SELECT COUNT(*)::int n FROM photos`))[0].n).toBe(0);
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR!, 'photos'))).toBe(false);
    expect((await post('gv1', [[JPG, 'a.jpg']], [[k[1]]]).expect(400)).body.code).toBe('CHILD_NOT_IN_CLASS'); // kids[1] is in c2
    expect((await post('gv1', [[JPG, 'a.jpg']], [[k[0]], []]).expect(400)).body.code).toBe('VALIDATION_ERROR'); // tags length ≠ files
  });

  it('ALB-05: fake images rejected; HEIC/PNG/WebP → JPEG; EXIF/GPS stripped, auto-rotated; size/count limits', async () => {
    for (const [b, n] of [[fx('gia_exe.heic'), 'gia_exe.heic'], [fx('gia_txt.heic'), 'x.jpg'], [Buffer.from('MZ\x90\x00 not an image'), 'virus.jpg']] as [Buffer, string][]) {
      const r = (await post('gv1', [[JPG, 'ok.jpg'], [b, n]]).expect(400)).body;
      expect(r).toMatchObject({ code: 'UNSUPPORTED_IMAGE', details: { file: n } });
    }
    expect((await ds.query(`SELECT COUNT(*)::int n FROM photos`))[0].n).toBe(0);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(15 * 1024 * 1024)]);
    expect((await post('gv1', [[big, 'big.jpg']]).expect(413)).body.code).toBe('FILE_TOO_LARGE');
    expect((await post('gv1', Array.from({ length: 21 }, (_, i) => [PNG, `${i}.png`] as [Buffer, string])).expect(400)).body.code).toBe('TOO_MANY_FILES');

    await consent('ph1', k[0], true);
    await consent('admin', k[6], true);
    const r = (await post('gv1', [[JPG, 'gps.jpg'], [fx('that.heic'), 'IMG_0001.HEIC'], [PNG, 'p.png'], [WEBP, 'w.webp']], [[k[0]], [k[6]], [], []]).expect(201)).body;
    postId = r.id;
    expect(r).toMatchObject({ classId: c1, caption: 'Vẽ tranh mùa thu', author: { name: expect.any(String) }, likeCount: 0 });
    expect(r.photos).toHaveLength(4);
    [p0, p1, p2] = r.photos.map((p: any) => p.id);
    expect(r.photos[0]).toMatchObject({ width: 20, height: 40, childIds: [k[0]], hidden: false }); // orientation 6 applied
    for (const ph of r.photos) {
      const b = (await file('gv1', ph.id).expect(200).expect('Content-Type', 'image/jpeg')).body as Buffer;
      const m = await sharp(b).metadata();
      expect(m.format).toBe('jpeg');
      expect(m.exif).toBeUndefined();
      expect(b.includes('GPS-TEST')).toBe(false);
    }
    const t = (await file('gv1', p0, '?size=thumb').expect(200)).body as Buffer;
    expect((await sharp(t).metadata()).format).toBe('jpeg');
    const [ev] = await audits('photo_post.create', postId);
    expect(ev.after.photos[0]).toEqual({ id: p0, childIds: [k[0]] });
    expect(await notes('ph1', 'photo_post')).toHaveLength(1);
    expect(await notes('ph2', 'photo_post')).toHaveLength(0);
  });

  it('ALB-04: only parents of the class view; others 403, no token 401; parents see only own child tags; download own child only', async () => {
    const l = (await as('ph1').get(`/classes/${c1}/photo-posts`).expect(200)).body;
    expect(l.items).toHaveLength(1);
    const ps = l.items[0].photos;
    expect(ps[0]).toMatchObject({ id: p0, childIds: [k[0]], mine: true, hiddenReason: null });
    expect(ps[1]).toMatchObject({ id: p1, childIds: [], mine: false }); // kids[6] not revealed to ph1
    await file('ph1', p1).expect(200);
    expect((await file('ph1', p0, '?download=1').expect(200)).headers['content-disposition']).toContain('attachment');
    await file('ph1', p1, '?download=1').expect(403);
    await as('ph2').get(`/classes/${c1}/photo-posts`).expect(403);
    await file('ph2', p0).expect(403);
    await file('ketoan', p0).expect(403);
    await file('gv2', p0).expect(403);
    await request(http).get(`/api/v1/photos/${p0}/file`).expect(401);
    await request(http).get(`/api/v1/classes/${c1}/photo-posts`).expect(401);
    expect((await as('gv1').get(`/classes/${c1}/photo-posts`).expect(200)).body.items[0].photos[1].childIds).toEqual([k[6]]);
    expect(fs.readdirSync(path.join(process.env.UPLOAD_DIR!, 'photos', c1))).toHaveLength(8); // not under a static route
    await request(http).get(`/uploads/photos/${c1}`).expect(404);
  });

  it('ALB-02: adding a non-consenting child later is blocked; consenting child ok', async () => {
    const r = (await as('gv1').put(`/photos/${p2}/tags`, { childIds: [k[3]] }).expect(422)).body;
    expect(r).toMatchObject({ code: 'PHOTO_CONSENT_MISSING', details: { children: [{ childId: k[3], name: expect.any(String) }] } });
    await as('gv2').put(`/photos/${p2}/tags`, { childIds: [k[6]] }).expect(403);
    await as('ph1').put(`/photos/${p2}/tags`, { childIds: [k[6]] }).expect(403);
    expect((await as('gv1').put(`/photos/${p2}/tags`, { childIds: [k[6]] }).expect(200)).body).toMatchObject({ id: p2, childIds: [k[6]] });
    expect((await audits('photo.tags', p2))[0].data).toMatchObject({ added: [k[6]], removed: [] });
  });

  it('ALB-03: consent off → every photo of the child auto-hidden (not deleted), direct URL 404 for parents, teachers see reason, audited', async () => {
    const r = (await consent('ph1', k[0], false)).body;
    expect(r).toMatchObject({ consent: false, hiddenPhotos: 1 });
    const ph1 = (await as('ph1').get(`/classes/${c1}/photo-posts`).expect(200)).body.items[0].photos.map((p: any) => p.id);
    expect(ph1).not.toContain(p0);
    await file('ph1', p0).expect(404);
    await file('ph1', p0, '?size=thumb').expect(404);
    const g = (await as('gv1').get(`/classes/${c1}/photo-posts`).expect(200)).body.items[0].photos.find((p: any) => p.id === p0);
    expect(g).toMatchObject({ hidden: true, hiddenReason: 'CONSENT_WITHDRAWN', hiddenForChildIds: [k[0]], hiddenFor: [{ childId: k[0], name: expect.any(String) }] });
    await file('gv1', p0).expect(200); // file kept
    const [ev] = await audits('photo.auto_hide', p0);
    expect(ev).toMatchObject({ reason: 'CONSENT_WITHDRAWN', actor_username: 'ph1', child_id: k[0] });
    expect(ev.after).toMatchObject({ hidden: true, hiddenForChildIds: [k[0]] });
    expect((await notes('gv1', 'photo_hidden')).length).toBe(1);
    expect((await post('gv1', [[PNG, 'x.png']], [[k[0]]]).expect(422)).body.code).toBe('PHOTO_CONSENT_MISSING');
  });

  it('ALB-09: untagging the child does not unhide (sticky hiddenForChildIds); audited', async () => {
    const r = (await as('gv1').put(`/photos/${p0}/tags`, { childIds: [] }).expect(200)).body;
    expect(r).toMatchObject({ childIds: [], hidden: true, hiddenForChildIds: [k[0]] });
    const [ev] = await audits('photo.tags', p0);
    expect(ev.before).toMatchObject({ childIds: [k[0]], hidden: true });
    expect(ev.after).toMatchObject({ childIds: [], hidden: true, hiddenForChildIds: [k[0]] });
    const u = (await as('gv1').post(`/photos/${p0}/unhide`).expect(422)).body;
    expect(u).toMatchObject({ code: 'PHOTO_CONSENT_MISSING', details: { children: [{ childId: k[0] }] } });
    await file('ph1', p0).expect(404);
  });

  it('ALB-07: re-consent does not auto-unhide; teacher unhides only when every hidden-for child and every tag consents', async () => {
    await consent('ph1', k[0], true);
    expect((await as('gv1').get(`/classes/${c1}/photo-posts`).expect(200)).body.items[0].photos.find((p: any) => p.id === p0).hidden).toBe(true);
    await file('ph1', p0).expect(404);
    // two children: p1 tagged k6 + k9, both withdraw → hiddenFor [k9, k6]; only k9 re-consents → still blocked
    await consent('admin', k[9], true);
    await as('gv1').put(`/photos/${p1}/tags`, { childIds: [k[6], k[9]] }).expect(200);
    expect((await consent('admin', k[9], false)).body.hiddenPhotos).toBe(1);
    expect((await consent('admin', k[6], false)).body.hiddenPhotos).toBe(2); // p1 (append) + p2
    expect((await ds.query(`SELECT hidden_for_child_ids FROM photos WHERE id = $1`, [p1]))[0].hidden_for_child_ids).toEqual([k[9], k[6]]);
    await consent('admin', k[9], true);
    const blocked = (await as('gv1').post(`/photos/${p1}/unhide`).expect(422)).body;
    expect(blocked.details.children.map((c: any) => c.childId)).toEqual([k[6]]);
    await consent('admin', k[6], true);
    await as('gv2').post(`/photos/${p1}/unhide`).expect(403);
    await as('ph1').post(`/photos/${p1}/unhide`).expect(403);
    expect((await as('gv1').post(`/photos/${p1}/unhide`).expect(200)).body).toMatchObject({ hidden: false, hiddenForChildIds: [] });
    // p0: hidden for k0 (consents again), no tags left → can be unhidden; a non-consenting current tag would block
    await ds.query(`INSERT INTO photo_tags (photo_id, child_id) VALUES ($1, $2)`, [p0, k[3]]); // legacy/odd data: tag without consent
    expect((await as('gv1').post(`/photos/${p0}/unhide`).expect(422)).body.details.children.map((c: any) => c.childId)).toEqual([k[3]]);
    await ds.query(`DELETE FROM photo_tags WHERE photo_id = $1 AND child_id = $2`, [p0, k[3]]);
    await as('gv1').post(`/photos/${p0}/unhide`).expect(200);
    expect((await audits('photo.unhide', p0))[0].before).toMatchObject({ hidden: true, hiddenForChildIds: [k[0]] });
    await file('ph1', p0).expect(200);
    expect((await as('gv1').post(`/photos/${p0}/unhide`).expect(409)).body.code).toBe('NOT_HIDDEN');
  });

  it('likes are idempotent; pagination; delete (author/admin only, soft)', async () => {
    await as('ph1').post(`/photo-posts/${postId}/like`).expect(200);
    expect((await as('ph1').post(`/photo-posts/${postId}/like`).expect(200)).body).toMatchObject({ likeCount: 1, likedByMe: true });
    await as('ph2').post(`/photo-posts/${postId}/like`).expect(403);
    expect((await as('gv1').get(`/photo-posts/${postId}`).expect(200)).body).toMatchObject({ likeCount: 1, likedByMe: false });
    expect((await as('ph1').del(`/photo-posts/${postId}/like`).expect(200)).body.likeCount).toBe(0);
    await post('admin', [[PNG, 'second.png']], undefined, 'Bài 2').expect(201);
    const pg = (await as('gv1').get(`/classes/${c1}/photo-posts?limit=1`).expect(200)).body;
    expect(pg.items[0].caption).toBe('Bài 2');
    const pg2 = (await as('gv1').get(`/classes/${c1}/photo-posts?limit=1&before=${encodeURIComponent(pg.nextBefore)}`).expect(200)).body;
    expect(pg2.items[0].id).toBe(postId);
    await as('gv2').del(`/photos/${p2}`).expect(403);
    await as('gv1').del(`/photos/${p2}`).expect(204);
    await file('gv1', p2).expect(404);
    expect((await audits('photo.delete', p2))).toHaveLength(1);
    await as('gv1').del(`/photo-posts/${pg.items[0].id}`).expect(403); // posted by admin
    await as('admin').del(`/photo-posts/${postId}`).expect(204);
    await file('ph1', p0).expect(404);
    expect((await as('ph1').get(`/classes/${c1}/photo-posts`).expect(200)).body.items.map((i: any) => i.id)).not.toContain(postId);
  });
});
