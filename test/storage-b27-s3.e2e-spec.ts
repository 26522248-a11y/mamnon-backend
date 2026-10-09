process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-b27-'));
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { todayStr } from '../src/common/dates';
import { findMissingFiles, nullMissingFiles } from '../src/common/missing-files';
import { S3Storage, setStorage, storage } from '../src/common/storage';
import { seed } from '../src/database/seed';

/** B27: every upload goes through storage(); with STORAGE_DRIVER=s3 (mocked client) nothing touches the container disk. */
describe('B27 uploads on S3/R2 (mocked client)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  const tok: Record<string, string> = {};
  const objects = new Map<string, { body: Buffer; type: string }>();
  const calls: string[] = [];
  const fake = { send: jest.fn(async (cmd: any) => {
    const name = cmd.constructor.name, { Bucket, Key } = cmd.input;
    calls.push(`${name}:${Key ?? cmd.input.Prefix}`);
    expect(Bucket).toBe('mamnon-uploads');
    if (name === 'PutObjectCommand') { objects.set(Key, { body: Buffer.from(cmd.input.Body), type: cmd.input.ContentType }); return {}; }
    if (name === 'GetObjectCommand') {
      const o = objects.get(Key); if (!o) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { ContentType: o.type, Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
    }
    if (name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
    if (name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter((k) => k.startsWith(cmd.input.Prefix)).map((k) => ({ Key: k })), IsTruncated: false };
    throw new Error('unexpected ' + name);
  }) };
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`).buffer(true),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`).send(body),
    upload: (url: string) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`),
  });
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

  beforeAll(async () => {
    setStorage(new S3Storage('mamnon-uploads', fake));
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    await seed(ds);
    for (const u of ['admin', 'gv1', 'ketoan', 'ph1', 'ph2']) tok[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
  });
  afterAll(async () => { setStorage(null); await app?.close(); });

  it('seed avatars live in the bucket (old ones listed + removed); child photo served from S3', async () => {
    expect(storage().driver).toBe('s3');
    expect(calls).toContain('ListObjectsV2Command:avatar-');
    const kid = (await ds.query(`SELECT c.id, c.photo_url FROM children c JOIN guardians g ON g.child_id = c.id JOIN users u ON u.id = g.user_id WHERE u.username = 'ph1' LIMIT 1`))[0];
    expect(objects.get(kid.photo_url)).toMatchObject({ type: 'image/png' });
    const r = await as('ph1').get(`/children/${kid.id}/photo`).expect(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(r.body, objects.get(kid.photo_url)!.body)).toBe(0);
    expect(fs.readdirSync(process.env.UPLOAD_DIR!)).toEqual([]); // nothing on the container disk
  });

  it('pickup photo: save → S3, serve (permission kept), missing object → 404, repair script nulls it', async () => {
    const kid = (await ds.query(`SELECT c.id, c.class_id FROM children c JOIN guardians g ON g.child_id = c.id JOIN users u ON u.id = g.user_id WHERE u.username = 'ph1' LIMIT 1`))[0];
    await ds.query(`DELETE FROM attendance WHERE child_id = $1 AND date = $2`, [kid.id, todayStr()]);
    const att = (await ds.query(`INSERT INTO attendance (child_id, class_id, date, status) VALUES ($1, $2, $3, 'present') RETURNING id`, [kid.id, kid.class_id, todayStr()]))[0].id;
    const dad = (await ds.query(`SELECT id FROM guardians WHERE child_id = $1 AND can_pickup ORDER BY created_at LIMIT 1`, [kid.id]))[0];
    const img = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4DA3FF' } }).jpeg().toBuffer();
    await as('gv1').upload(`/attendance/${att}/pickup`).field('guardianId', dad.id).attach('photo', img, 'p.jpg').expect(201);
    const key = (await ds.query(`SELECT photo_url FROM pickups WHERE attendance_id = $1`, [att]))[0].photo_url;
    expect(objects.get(key)).toMatchObject({ type: 'image/jpeg' });
    const ph = await as('ph1').get(`/attendance/${att}/pickup-photo`).expect(200);
    expect(ph.headers['content-type']).toMatch(/image\/jpeg/);
    expect(ph.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(ph.body, img)).toBe(0);
    await as('ph2').get(`/attendance/${att}/pickup-photo`).expect(404); // not their child
    // object gone (the B27 symptom) → clean 404, not 500
    objects.delete(key);
    expect((await as('ph1').get(`/attendance/${att}/pickup-photo`).expect(404)).body.message).toBe('Không có ảnh');
    // repair: dry run finds it, apply clears it
    const missing = await findMissingFiles(ds.manager, storage());
    expect(missing).toContainEqual(expect.objectContaining({ table: 'pickups', column: 'photo_url', stored: key, nullable: true }));
    expect(await ds.transaction((m) => nullMissingFiles(m, missing))).toBeGreaterThanOrEqual(1);
    expect((await ds.query(`SELECT photo_url FROM pickups WHERE attendance_id = $1`, [att]))[0].photo_url).toBeNull();
    expect((await findMissingFiles(ds.manager, storage())).filter((x) => x.nullable)).toEqual([]);
  });

  it('receipt: save image → S3, replace with PDF deletes old object, serve with type + filename, missing → 404', async () => {
    const cat = (await ds.query(`SELECT id FROM finance_categories WHERE kind = 'out' AND is_active ORDER BY name LIMIT 1`))[0].id;
    const e = (await as('ketoan').upload('/finance/entries').field('kind', 'out').field('date', todayStr()).field('title', 'B27 hoá đơn')
      .field('amount', '120000').field('categoryId', cat).attach('receipt', PNG, 'hoa-don.png').expect(201)).body;
    const k1 = (await ds.query(`SELECT receipt_key FROM finance_entries WHERE id = $1`, [e.id]))[0].receipt_key;
    expect(objects.get(k1)).toMatchObject({ type: 'image/png' });
    const r1 = await as('admin').get(`/finance/entries/${e.id}/receipt`).expect(200);
    expect(r1.headers['content-type']).toBe('image/png');
    expect(r1.headers['content-disposition']).toBe(`inline; filename*=UTF-8''hoa-don.png`);
    const pdf = Buffer.from('%PDF-1.4\n%test\n');
    await as('ketoan').upload(`/finance/entries/${e.id}/receipt`).attach('receipt', pdf, 'dien.pdf').expect(200);
    const k2 = (await ds.query(`SELECT receipt_key FROM finance_entries WHERE id = $1`, [e.id]))[0].receipt_key;
    expect(objects.has(k1)).toBe(false); // old object deleted
    expect(objects.get(k2)).toMatchObject({ type: 'application/pdf' });
    const r2 = await as('ketoan').get(`/finance/entries/${e.id}/receipt`).expect(200);
    expect(r2.headers['content-type']).toMatch(/application\/pdf/);
    expect(r2.headers['content-disposition']).toBe(`inline; filename*=UTF-8''dien.pdf`);
    await as('ph1').get(`/finance/entries/${e.id}/receipt`).expect(403);
    objects.delete(k2);
    expect((await as('ketoan').get(`/finance/entries/${e.id}/receipt`).expect(404)).body.message).toBe('Không tìm thấy file hoá đơn');
    const missing = await findMissingFiles(ds.manager, storage());
    expect(missing).toContainEqual(expect.objectContaining({ table: 'finance_entries', column: 'receipt_key', id: e.id, nullable: true }));
    await ds.transaction((m) => nullMissingFiles(m, missing));
    expect((await ds.query(`SELECT receipt_key, receipt_name FROM finance_entries WHERE id = $1`, [e.id]))[0]).toEqual({ receipt_key: null, receipt_name: null });
  });

  it('picker photo saved + served from S3; S3 errors other than NoSuchKey are not swallowed', async () => {
    const kid = (await ds.query(`SELECT c.id FROM children c JOIN guardians g ON g.child_id = c.id JOIN users u ON u.id = g.user_id WHERE u.username = 'ph1' LIMIT 1`))[0];
    const img = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#FFAA00' } }).jpeg().toBuffer();
    const p = (await as('ph1').upload(`/children/${kid.id}/authorized-pickers`).field('fullName', 'Bà B27').field('phone1', '0911000270').attach('photo', img, 'a.jpg').expect(201)).body;
    const k1 = (await ds.query(`SELECT photo_url FROM authorized_pickers WHERE id = $1`, [p.id]))[0].photo_url;
    expect(objects.has(k1)).toBe(true);
    await as('admin').get(`/authorized-pickers/${p.id}/photo`).expect(200);
    const s3 = new S3Storage('b', { send: async () => { throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); } });
    await expect(s3.get('x.jpg')).rejects.toThrow('AccessDenied');
  });
});
