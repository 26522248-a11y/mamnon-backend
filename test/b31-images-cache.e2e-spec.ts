process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-b31-'));
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { todayStr } from '../src/common/dates';
import { CachedStorage, FileStorage, S3Storage, setStorage } from '../src/common/storage';
import { cacheHeaders, etagOf, normalizeImage } from '../src/common/upload';
import { ImageQueue, imageQueue, QUEUE_FULL_MESSAGE, setImageQueue } from '../src/common/image-queue';
import { storage } from '../src/common/storage';
import { seed } from '../src/database/seed';

/** B31: B2 free tier (2,500 GetObject + 1 GB/day) – resize on upload, strip EXIF/GPS, immutable/ETag caching, 304 without a read. */
const exifPhoto = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#3a7' } })
  .withExif({ IFD0: { Make: 'TestPhone', Model: 'X' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 46/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '106/1 42/1 0/1' } })
  .withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();

describe('B31 image normalisation (unit)', () => {
  it('photo: auto-rotates by EXIF, long edge 1280, JPEG, no EXIF/GPS/orientation left', async () => {
    const src = await exifPhoto(4000, 3000);
    const m0 = await sharp(src).metadata();
    expect(m0.exif).toBeDefined(); expect(m0.orientation).toBe(6); // fixture really carries EXIF + GPS
    const out = await normalizeImage(src, 'photo');
    const m = await sharp(out).metadata();
    expect([m.format, m.width, m.height]).toEqual(['jpeg', 960, 1280]); // portrait after applying orientation 6
    expect(m.exif).toBeUndefined(); expect(m.orientation).toBeUndefined(); expect(m.xmp).toBeUndefined(); expect(m.iptc).toBeUndefined();
    expect(out.length).toBeLessThan(src.length);
  });
  it('avatar 512px, document 2048px, small images never enlarged, PNG alpha → JPEG on white, garbage → 400', async () => {
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#123' } }).jpeg().toBuffer();
    expect((await sharp(await normalizeImage(big, 'avatar')).metadata()).width).toBe(512);
    expect((await sharp(await normalizeImage(big, 'document')).metadata()).width).toBe(2048);
    const small = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#123' } }).jpeg().toBuffer();
    expect((await sharp(await normalizeImage(small)).metadata()).width).toBe(200);
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const pm = await sharp(await normalizeImage(png)).metadata();
    expect([pm.format, pm.hasAlpha]).toEqual(['jpeg', false]);
    await expect(normalizeImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50)]))).rejects.toMatchObject({ status: 400 });
  });
  it('cache policy: UUID keys get ETag; seed avatars / legacy names never do', () => {
    const k = '0b6d7c1e-1a2b-4c3d-8e9f-0123456789ab.jpg';
    expect(cacheHeaders(k, 'immutable')).toEqual({ cacheControl: 'private, max-age=31536000, immutable', etag: etagOf(k) });
    expect(cacheHeaders(`announcements/${k.replace('.jpg', '_thumb.jpg')}`, 'immutable').etag).toMatch(/^"k-/);
    expect(cacheHeaders(k, 'revalidate')).toEqual({ cacheControl: 'private, no-cache', etag: etagOf(k) });
    expect(cacheHeaders(k, 'no-store')).toEqual({ cacheControl: 'private, no-store', etag: null });
    expect(cacheHeaders('avatar-0b6d7c1e-1a2b-4c3d-8e9f-0123456789ab.png', 'revalidate')).toEqual({ cacheControl: 'private, no-cache', etag: null });
    expect(etagOf(k)).not.toContain(k.slice(0, 8)); // the storage key is not leaked
  });
});

describe('B31 CachedStorage LRU (unit)', () => {
  const inner = () => {
    const m = new Map<string, Buffer>(); const calls = { get: 0 };
    const s: FileStorage = { driver: 's3', put: async (k, d) => { m.set(k, d); }, get: async (k) => { calls.get++; return m.get(k) ?? null; }, exists: async (k) => m.has(k),
      remove: async (k) => { m.delete(k); }, list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)), publicUrl: () => null };
    return { s, m, calls };
  };
  it('hits skip the bucket; bounded by bytes (LRU eviction) and per-item size; put/remove stay coherent', async () => {
    const { s, m, calls } = inner();
    const c = new CachedStorage(s, 300, 150);
    for (const k of ['a', 'b', 'c']) m.set(k, Buffer.alloc(100, k));
    await c.get('a'); await c.get('a'); await c.get('a');
    expect(calls.get).toBe(1); expect(c.stats).toEqual({ hits: 2, misses: 1 });
    await c.get('b'); await c.get('c'); await c.get('a'); // a is most recent
    m.set('d', Buffer.alloc(100, 'd')); await c.get('d'); // 400 > 300 → evicts least recent (b)
    expect(c.size.bytes).toBeLessThanOrEqual(300);
    const before = calls.get; await c.get('a'); expect(calls.get).toBe(before); // still cached
    await c.get('b'); expect(calls.get).toBe(before + 1); // was evicted
    m.set('big', Buffer.alloc(200)); await c.get('big'); await c.get('big'); expect(calls.get).toBe(before + 3); // > maxItem: never cached
    await c.put('a', Buffer.from('new'), 'image/jpeg'); expect((await c.get('a'))!.toString()).toBe('new');
    await c.remove('a'); expect(await c.get('a')).toBeNull();
  });
});

describe('B31 image queue + sharp limits (unit)', () => {
  const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => (resolve = r)); return { p, resolve }; };
  it('concurrency 1: tasks run one at a time, FIFO; a failing task frees its slot', async () => {
    const q = new ImageQueue(1, 10);
    let cur = 0, max = 0; const order: number[] = []; const gates = [deferred(), deferred(), deferred()];
    const job = (i: number, fail = false) => q.run(async () => { cur++; max = Math.max(max, cur); order.push(i); await gates[i].p; cur--; if (fail) throw new Error('boom'); return i; });
    const ps = [job(0), job(1, true), job(2)];
    await new Promise((r) => setImmediate(r));
    expect(q.stats).toEqual({ active: 1, waiting: 2 });
    gates.forEach((g) => g.resolve());
    const res = await Promise.allSettled(ps);
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect([max, order]).toEqual([1, [0, 1, 2]]);
    expect(q.stats).toEqual({ active: 0, waiting: 0 });
  });
  it('bounded queue: when full → 503 IMAGE_QUEUE_FULL (Vietnamese message, Retry-After)', async () => {
    const q = new ImageQueue(1, 2); const g = deferred();
    const running = [q.run(() => g.p), q.run(async () => 1), q.run(async () => 2)];
    await expect(q.run(async () => 3)).rejects.toMatchObject({ status: 503, code: 'IMAGE_QUEUE_FULL', retryAfter: 30, message: QUEUE_FULL_MESSAGE });
    g.resolve(); await Promise.all(running);
    await expect(q.run(async () => 'ok')).resolves.toBe('ok');
  });
  it('defaults: 1 at a time / 10 waiting (env-configurable); sharp: 1 libvips thread, cache off; LRU default 24 MB', () => {
    setImageQueue(null);
    process.env.IMAGE_PROCESS_CONCURRENCY = '2'; process.env.IMAGE_QUEUE_MAX = '4';
    expect([imageQueue().concurrency, imageQueue().maxQueue]).toEqual([2, 4]);
    setImageQueue(null); delete process.env.IMAGE_PROCESS_CONCURRENCY; delete process.env.IMAGE_QUEUE_MAX;
    expect([imageQueue().concurrency, imageQueue().maxQueue]).toEqual([1, 10]);
    setImageQueue(null);
    expect(sharp.concurrency()).toBe(1);
    expect(sharp.cache()).toMatchObject({ memory: { max: 0 }, items: { max: 0 } });
    const env = { ...process.env };
    Object.assign(process.env, { STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', S3_BUCKET: 'b', S3_ACCESS_KEY: 'k', S3_SECRET: 's' });
    delete process.env.STORAGE_CACHE_MB;
    setStorage(null);
    const st = storage() as CachedStorage;
    expect(st).toBeInstanceOf(CachedStorage);
    expect(st.size.maxBytes).toBe(24 * 1024 * 1024);
    setStorage(null); process.env = env;
  });
});

describe('B31 HTTP caching on S3 (mocked client counting GetObject)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  const tok: Record<string, string> = {};
  const objects = new Map<string, Buffer>();
  const gets: string[] = [];
  const fake = { send: jest.fn(async (cmd: any) => {
    const name = cmd.constructor.name, { Key } = cmd.input;
    if (name === 'PutObjectCommand') { objects.set(Key, Buffer.from(cmd.input.Body)); return {}; }
    if (name === 'GetObjectCommand') { gets.push(Key); const o = objects.get(Key); if (!o) throw Object.assign(new Error('nf'), { name: 'NoSuchKey' }); return { Body: { transformToByteArray: async () => new Uint8Array(o) } }; }
    if (name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
    if (name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter((k) => k.startsWith(cmd.input.Prefix)).map((k) => ({ Key: k })) };
    throw new Error('unexpected ' + name);
  }) };
  const get = (who: string, url: string, etag?: string) => {
    const r = request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tok[who]}`).buffer(true);
    return etag ? r.set('If-None-Match', etag) : r;
  };

  beforeAll(async () => {
    setStorage(new S3Storage('b', fake)); // no LRU here: every 200 must be a real GetObject, every 304 none
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
  const kidOf = async (u: string) => (await ds.query(`SELECT c.id, c.class_id FROM children c JOIN guardians g ON g.child_id = c.id JOIN users u ON u.id = g.user_id WHERE u.username = $1 LIMIT 1`, [u]))[0];

  it('pickup photo: stored resized without EXIF; immutable + ETag; If-None-Match → 304 with NO GetObject; permission checked before 304', async () => {
    const kid = await kidOf('ph1');
    await ds.query(`DELETE FROM attendance WHERE child_id = $1 AND date = $2`, [kid.id, todayStr()]);
    const att = (await ds.query(`INSERT INTO attendance (child_id, class_id, date, status) VALUES ($1, $2, $3, 'present') RETURNING id`, [kid.id, kid.class_id, todayStr()]))[0].id;
    const dad = (await ds.query(`SELECT id FROM guardians WHERE child_id = $1 AND can_pickup ORDER BY created_at LIMIT 1`, [kid.id]))[0];
    await request(http).post(`/api/v1/attendance/${att}/pickup`).set('Authorization', `Bearer ${tok.gv1}`).field('guardianId', dad.id)
      .attach('photo', await exifPhoto(4032, 3024), 'p.jpg').expect(201);
    const key = (await ds.query(`SELECT photo_url FROM pickups WHERE attendance_id = $1`, [att]))[0].photo_url;
    const m = await sharp(objects.get(key)!).metadata();
    expect([m.width, m.height, m.exif, m.orientation]).toEqual([960, 1280, undefined, undefined]);

    const n0 = gets.length;
    const r = await get('ph1', `/attendance/${att}/pickup-photo`).expect(200);
    expect(r.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(r.headers.etag).toBe(etagOf(key));
    expect(gets.length).toBe(n0 + 1);
    const nm = await get('ph1', `/attendance/${att}/pickup-photo`, r.headers.etag).expect(304);
    expect(nm.body.length ?? 0).toBe(0);
    await get('gv1', `/attendance/${att}/pickup-photo`, `W/${r.headers.etag}, "other"`).expect(304);
    expect(gets.length).toBe(n0 + 1); // the two 304s did not touch the bucket
    // permission is checked BEFORE the 304 shortcut
    await get('ph2', `/attendance/${att}/pickup-photo`, r.headers.etag).expect(404);
    await request(http).get(`/api/v1/attendance/${att}/pickup-photo`).set('If-None-Match', r.headers.etag).expect(401);
    await get('ph1', `/attendance/${att}/pickup-photo`, '"stale"').expect(200);
    expect(gets.length).toBe(n0 + 2);
  });

  it('child photo: avatar 512px; same URL after replace → no-cache + ETag; old ETag gets the new photo, current ETag → 304', async () => {
    const kid = await kidOf('ph1');
    const up = (f: Buffer) => request(http).post(`/api/v1/children/${kid.id}/photo`).set('Authorization', `Bearer ${tok.gv1}`).attach('file', f, 'a.jpg').expect(201);
    await up(await exifPhoto(2000, 1500));
    const k1 = (await ds.query(`SELECT photo_url FROM children WHERE id = $1`, [kid.id]))[0].photo_url;
    expect((await sharp(objects.get(k1)!).metadata()).height).toBe(512);
    const r1 = await get('ph1', `/children/${kid.id}/photo`).expect(200);
    expect(r1.headers['cache-control']).toBe('private, no-cache');
    const n0 = gets.length;
    await get('ph1', `/children/${kid.id}/photo`, r1.headers.etag).expect(304);
    expect(gets.length).toBe(n0);
    await up(await sharp({ create: { width: 300, height: 300, channels: 3, background: '#f00' } }).jpeg().toBuffer());
    const r2 = await get('ph1', `/children/${kid.id}/photo`, r1.headers.etag).expect(200); // replaced → full response
    expect(r2.headers.etag).not.toBe(r1.headers.etag);
    await get('ph2', `/children/${kid.id}/photo`, r2.headers.etag).expect((x) => expect([403, 404]).toContain(x.status));
  });

  it('tester case: plain 4000×3000 JPG and PNG uploads are resized too (not only HEIC); picker photo revalidates', async () => {
    const kid = await kidOf('ph1');
    const jpg = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#09f' } }).jpeg({ quality: 95 }).toBuffer();
    const png = await sharp({ create: { width: 4000, height: 3000, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 0.5 } } }).png().toBuffer();
    for (const [buf, name, phone] of [[jpg, 'big.jpg', '0911000311'], [png, 'big.png', '0911000312']] as const) {
      const p = (await request(http).post(`/api/v1/children/${kid.id}/authorized-pickers`).set('Authorization', `Bearer ${tok.ph1}`)
        .field('fullName', `B31 ${name}`).field('phone1', phone).attach('photo', buf, name).expect(201)).body;
      const k = (await ds.query(`SELECT photo_url FROM authorized_pickers WHERE id = $1`, [p.id]))[0].photo_url;
      expect(k).toMatch(/\.jpg$/);
      const m = await sharp(objects.get(k)!).metadata();
      expect([m.format, m.width, m.height]).toEqual(['jpeg', 1280, 960]);
      expect(objects.get(k)!.length).toBeLessThan(buf.length);
      const r = await get('admin', `/authorized-pickers/${p.id}/photo`).expect(200);
      expect(r.headers['cache-control']).toBe('private, no-cache');
      const n0 = gets.length;
      await get('admin', `/authorized-pickers/${p.id}/photo`, r.headers.etag).expect(304);
      expect(gets.length).toBe(n0);
    }
  });

  it('upload limit 10 MB: ~8 MB photo accepted (and shrunk), >10 MB → 413 with Vietnamese message', async () => {
    const kid = await kidOf('ph1');
    const small = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#a50' } }).jpeg().toBuffer();
    const eight = Buffer.concat([small, Buffer.alloc(8 * 1024 * 1024 - small.length)]); // valid JPEG + trailing bytes, 8 MB
    const ok = await request(http).post(`/api/v1/children/${kid.id}/photo`).set('Authorization', `Bearer ${tok.gv1}`).attach('file', eight, 'big.jpg').expect(201);
    expect(ok.body.photoUrl).toBeTruthy();
    const k = (await ds.query(`SELECT photo_url FROM children WHERE id = $1`, [kid.id]))[0].photo_url;
    expect(objects.get(k)!.length).toBeLessThan(200 * 1024);
    const tooBig = Buffer.concat([small, Buffer.alloc(10 * 1024 * 1024 + 1024)]);
    const r = await request(http).post(`/api/v1/children/${kid.id}/photo`).set('Authorization', `Bearer ${tok.gv1}`).attach('file', tooBig, 'huge.jpg').expect(413);
    expect(r.body).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: 'File quá lớn so với giới hạn cho phép' });
  });

  it('queue: parallel uploads are processed one at a time; full queue → 503 IMAGE_QUEUE_FULL + Retry-After', async () => {
    class Tracking extends ImageQueue { cur = 0; max = 0; n = 0;
      run<T>(task: () => Promise<T>) { return super.run(async () => { this.cur++; this.n++; this.max = Math.max(this.max, this.cur); try { return await task(); } finally { this.cur--; } }); } }
    const q = new Tracking(1, 10); setImageQueue(q);
    const kid = await kidOf('ph1');
    const img = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#0a5' } }).jpeg().toBuffer();
    const rs = await Promise.all([0, 1, 2].map((i) => request(http).post(`/api/v1/children/${kid.id}/authorized-pickers`).set('Authorization', `Bearer ${tok.ph1}`)
      .field('fullName', `B31 queue ${i}`).field('phone1', `091100032${i}`).attach('photo', img, 'q.jpg')));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    expect([q.n, q.max]).toEqual([3, 1]);
    // full: 1 running, 0 waiting allowed
    let release!: () => void; const full = new ImageQueue(1, 0); setImageQueue(full);
    const blocker = full.run(() => new Promise<void>((r) => (release = r)));
    const busy = await request(http).post(`/api/v1/children/${kid.id}/photo`).set('Authorization', `Bearer ${tok.gv1}`).attach('file', img, 'a.jpg').expect(503);
    expect(busy.body).toEqual({ code: 'IMAGE_QUEUE_FULL', message: QUEUE_FULL_MESSAGE });
    expect(busy.headers['retry-after']).toBe('30');
    release(); await blocker; setImageQueue(null);
    await request(http).post(`/api/v1/children/${kid.id}/photo`).set('Authorization', `Bearer ${tok.gv1}`).attach('file', img, 'a.jpg').expect(201);
  });

  it('seed placeholder avatar (rewritable key) has no ETag; receipts stay private, no-store', async () => {
    const other = (await ds.query(`SELECT id FROM children WHERE photo_url LIKE 'avatar-%' LIMIT 1`))[0];
    const a = await get('admin', `/children/${other.id}/photo`).expect(200);
    expect(a.headers.etag).toBeUndefined();
    expect(a.headers['cache-control']).toBe('private, no-cache');
    const cat = (await ds.query(`SELECT id FROM finance_categories WHERE kind = 'out' AND is_active ORDER BY name LIMIT 1`))[0].id;
    const img = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const e = (await request(http).post('/api/v1/finance/entries').set('Authorization', `Bearer ${tok.ketoan}`).field('kind', 'out').field('date', todayStr())
      .field('title', 'B31').field('amount', '1000').field('categoryId', cat).attach('receipt', img, 'r.jpg').expect(201)).body;
    const k = (await ds.query(`SELECT receipt_key FROM finance_entries WHERE id = $1`, [e.id]))[0].receipt_key;
    expect((await sharp(objects.get(k)!).metadata()).height).toBe(2048); // document profile
    const r = await get('ketoan', `/finance/entries/${e.id}/receipt`, etagOf(k)).expect(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers.etag).toBeUndefined();
  });
});
