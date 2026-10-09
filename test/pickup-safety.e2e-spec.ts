process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
process.env.NOTIFY_CHANNELS = 'inapp,webpush,sms,zalo';
process.env.AUDIT_LOG_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-audit');
process.env.PUBLIC_API_BASE = 'https://api.test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vapid = require('web-push').generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@mamnon.local';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { setPushTransport } from '../src/notifications/channels';
import { seed } from '../src/database/seed';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CCCD = '079123456789';

describe('An toàn đón trẻ – đợt 1 (e2e, tester cases PK-*)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const pushes: { endpoint: string; payload: any }[] = [];
  let pushFail: number | null = null;
  const login = (username: string, password = '123456') => request(http).post('/api/v1/auth/login').send({ username, password });
  const as = (who: string) => {
    const t = () => ({ Authorization: `Bearer ${tokens[who]}` });
    return {
      get: (url: string) => request(http).get('/api/v1' + url).set(t()),
      post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(t()).send(body),
      patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set(t()).send(body),
      put: (url: string, body?: any) => request(http).put('/api/v1' + url).set(t()).send(body),
      del: (url: string, body?: any) => request(http).delete('/api/v1' + url).set(t()).send(body),
      multipart: (url: string) => request(http).post('/api/v1' + url).set(t()),
    };
  };
  let c1Kids: any[];
  const att: Record<number, string> = {};
  const attId = async (i: number) => {
    if (att[i]) return att[i];
    const k = c1Kids[i];
    const r = await as('gv1').put(`/classes/${s.classes.c1.id}/attendance`, { date: todayStr(), items: [{ childId: k.id, status: 'present' }] }).expect(200);
    return (att[i] = r.body.items.find((x: any) => x.childId === k.id).attendanceId);
  };
  const newReq = async (i: number, extra: Record<string, string> = {}) => {
    const r = as('gv1').multipart(`/attendance/${await attId(i)}/pickup-requests`)
      .field('pickerName', extra.pickerName ?? 'Chú Tư').field('pickerPhone', extra.pickerPhone ?? '0909123456').field('note', 'Mẹ bé gọi báo').field('relation', extra.relation ?? 'Chú');
    if (extra.pickerIdNumber) r.field('pickerIdNumber', extra.pickerIdNumber);
    return (await r.attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' }).expect(201)).body;
  };
  const onBehalf = (id: string) => as('admin').post(`/pickup-requests/${id}/parent-decision`, { decision: 'approve', note: 'Đã gọi mẹ bé' }).expect(200);
  const handover = async (who: string, i: number, body: any, status: number) => as(who).post(`/attendance/${await attId(i)}/pickup`, body).expect(status);

  beforeAll(async () => {
    setPushTransport(async (sub, payload) => {
      if (pushFail) { const e: any = new Error('push failed'); e.statusCode = pushFail; throw e; }
      pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'gv2', 'gv3', 'ketoan', 'ph1', 'ph2']) tokens[u] = (await login(u)).body.accessToken;
    c1Kids = [s.kids[0], ...s.kids.filter((k: any) => k.classId === s.classes.c1.id && k.id !== s.kids[0].id)];
  });
  afterAll(async () => { setPushTransport(null); await app?.close(); });

  // ───────────── A. authorized pickers ─────────────
  let pickerId: string;
  describe('A. người đón hộ', () => {
    const create = (who: string, childId: string) => as(who).multipart(`/children/${childId}/authorized-pickers`)
      .field('fullName', 'Trần Văn Tư').field('relation', 'Chú ruột').field('idNumber', CCCD).field('phone1', '0912 345 678').field('phone2', '0987654321');

    it('PK-A01: parent adds name, relation, photo, 12-digit CCCD, 2 phones -> 201 pending, listed (CCCD masked)', async () => {
      const r = await create('ph1', s.kids[0].id).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
      expect(r.body).toMatchObject({ childId: s.kids[0].id, fullName: 'Trần Văn Tư', relation: 'Chú ruột', phone1: '0912345678', phone2: '0987654321',
        status: 'pending', onList: false, idNumberMasked: '********6789', photoUrl: `/api/v1/authorized-pickers/${r.body.id}/photo` });
      expect(JSON.stringify(r.body)).not.toContain(CCCD);
      pickerId = r.body.id;
      const people = await as('ph1').get(`/children/${s.kids[0].id}/pickup-people`).expect(200);
      expect(people.body.authorizedPickers.map((p: any) => p.id)).toContain(pickerId);
      expect(people.body.guardians.length).toBeGreaterThan(0);
      expect(JSON.stringify(people.body)).not.toContain(CCCD);
      // the admin approval queue sees it, and admins got a notification
      expect((await as('admin').get('/authorized-pickers?status=pending').expect(200)).body.map((p: any) => p.id)).toContain(pickerId);
      expect((await as('admin').get('/notifications').expect(200)).body.items.some((n: any) => n.type === 'picker_registration' && n.data.authorizedPickerId === pickerId)).toBe(true);
      // same CCCD twice on the same child -> 409
      await create('ph1', s.kids[0].id).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(409);
    });

    it('PK-A02 / A03: missing photo or CCCD -> 400; bad CCCD / phone / fake image -> 400', async () => {
      expect((await create('ph1', s.kids[0].id).expect(400)).body.code).toBe('PHOTO_REQUIRED');
      await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'A').field('relation', 'Cô').field('phone1', '0912345678')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(400);
      await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'A').field('relation', 'Cô').field('idNumber', '07912345678a').field('phone1', '0912345678')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(400);
      await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'A').field('relation', 'Cô').field('idNumber', '079123456780').field('phone1', '12345')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(400);
      await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'A').field('relation', 'Cô').field('idNumber', '079123456780').field('phone1', '0912345678')
        .attach('photo', Buffer.from('not an image at all'), { filename: 'a.png', contentType: 'image/png' }).expect(400);
    });

    it('PK-A04: parent adds a picker for a child that is not theirs -> 403 (teacher cannot add either)', async () => {
      await create('ph1', s.kids[1].id).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(403);
      await create('gv1', s.kids[0].id).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(403);
    });

    it('PK-A05: photo/CCCD: no login 401, other parent 403, other-class teacher 403', async () => {
      const url = `/api/v1/authorized-pickers/${pickerId}/photo`;
      await request(http).get(url).expect(401);
      await request(http).get(url).set('Authorization', `Bearer ${tokens.ph2}`).expect(403);
      await request(http).get(url).set('Authorization', `Bearer ${tokens.gv2}`).expect(403);
      expect((await request(http).get(url).set('Authorization', `Bearer ${tokens.gv1}`).expect(200)).headers['content-type']).toBe('image/png');
      await request(http).get(url).set('Authorization', `Bearer ${tokens.ph1}`).expect(200);
      await as('ph2').get(`/children/${s.kids[0].id}/pickup-people`).expect(403);
      await as('gv2').get(`/children/${s.kids[0].id}/pickup-people`).expect(403);
      await request(http).get(`/api/v1/children/${s.kids[0].id}/pickup-people`).expect(401);
      // full CCCD: only admin / class teacher on the hand-over screen
      const a = await attId(0);
      await as('gv2').get(`/attendance/${a}/pickup-identity?kind=authorized_picker&id=${pickerId}`).expect(403);
      await as('ph1').get(`/attendance/${a}/pickup-identity?kind=authorized_picker&id=${pickerId}`).expect(403);
      await request(http).get(`/api/v1/attendance/${a}/pickup-identity?kind=authorized_picker&id=${pickerId}`).expect(401);
    });

    it('PK-A06 (P1): edit / delete take effect immediately with history; identity change -> pending again', async () => {
      const r = await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'Lê Thị Năm').field('relation', 'Dì').field('idNumber', '079000000001').field('phone1', '0911000001')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
      const up = await as('ph1').patch(`/authorized-pickers/${r.body.id}`, { phone2: '0911000002' }).expect(200);
      expect(up.body.phone2).toBe('0911000002');
      await as('ph1').del(`/authorized-pickers/${r.body.id}`).expect(204);
      expect((await as('ph1').get(`/children/${s.kids[0].id}/pickup-people`).expect(200)).body.authorizedPickers.map((p: any) => p.id)).not.toContain(r.body.id);
      const h = await as('ph1').get(`/authorized-pickers/${r.body.id}/history`).expect(200);
      expect(h.body.items.map((x: any) => x.action)).toEqual(['create', 'update', 'delete']);
      expect(JSON.stringify(h.body)).not.toContain('079000000001');
    });
  });

  // ───────────── B. off-list requests, push ─────────────
  let req0: any;
  describe('B. yêu cầu ngoài danh sách + web push', () => {
    it('subscriptions: ph1 and ph2 register a browser', async () => {
      expect((await request(http).get('/api/v1/push/vapid-public-key').expect(200)).body).toMatchObject({ publicKey: vapid.publicKey, enabled: true });
      for (const who of ['ph1', 'ph2', 'gv1']) await as(who).post('/push/subscriptions', { endpoint: `https://push.example.test/${who}`, keys: { p256dh: 'BPk', auth: 'au' } }).expect(201);
      expect((await as('ph1').get('/push/subscriptions').expect(200)).body).toHaveLength(1);
    });

    it('PK-B01 / B03: teacher creates a request with photo -> web push to THIS child\'s parents only, with confirm/reject actions', async () => {
      pushes.length = 0;
      req0 = await newReq(0, { pickerIdNumber: '079555555555' });
      expect(req0).toMatchObject({ status: 'pending', parent: { status: 'pending' }, school: { status: 'pending' }, readyForHandover: false, pickerIdNumberMasked: '********5555' });
      expect(req0.delivery.find((d: any) => d.channel === 'webpush')).toMatchObject({ sent: 1 });
      expect(pushes.map((p) => p.endpoint)).toEqual(['https://push.example.test/ph1']);
      const p = pushes[0].payload;
      expect(p.actions.map((a: any) => a.action)).toEqual(['confirm', 'reject']);
      expect(p.requireInteraction).toBe(true);
      expect(p.data).toMatchObject({ type: 'pickup_request', pickupRequestId: req0.id, actionUrl: 'https://api.test/api/v1/push/actions' });
      expect(p.data.actionToken).toEqual(expect.any(String));
      expect(p.data.photoUrl).toContain(`/api/v1/push/pickup-photo/${req0.id}?t=`);
      // photo from the SW (token, no session) works; forged token does not
      await request(http).get(p.data.photoUrl.replace('https://api.test', '')).expect(200);
      await request(http).get(`/api/v1/push/pickup-photo/${req0.id}?t=forged`).expect(403);
      // sms / zalo stubs are logged as skipped (pluggable channel layer)
      const [{ n }] = await ds.query(`SELECT COUNT(*)::int n FROM notification_deliveries WHERE ref_id = $1 AND channel IN ('sms','zalo') AND status = 'skipped'`, [req0.id]);
      expect(n).toBeGreaterThan(0);
    });

    it('PK-B04 / B05: without push the parent still sees it on top of the pickup feed (with photo); not in the general inbox', async () => {
      await as('ph1').del('/push/subscriptions', { endpoint: 'https://push.example.test/ph1' }).expect(204);
      const f = await as('ph1').get('/pickup-requests/feed').expect(200);
      expect(f.body.pendingCount).toBeGreaterThanOrEqual(1);
      expect(f.body.items[0]).toMatchObject({ id: req0.id, needsMyAction: true, photoUrl: `/api/v1/pickup-requests/${req0.id}/photo`, pickerName: 'Chú Tư' });
      expect((await as('ph1').get('/notifications').expect(200)).body.items.some((n: any) => n.type === 'pickup_request')).toBe(false);
      expect((await as('ph2').get('/pickup-requests/feed').expect(200)).body.items).toHaveLength(0);
      await as('gv1').get('/pickup-requests/feed').expect(403);
      await as('ph1').post('/push/subscriptions', { endpoint: 'https://push.example.test/ph1', keys: { p256dh: 'BPk', auth: 'au' } }).expect(201);
    });

    it('PK-B07: confirm from push with a forged link / another request id -> 403', async () => {
      await request(http).post('/api/v1/push/actions').send({ token: 'forged.token.here', action: 'confirm' }).expect(403);
      const other = await newReq(1, { pickerName: 'Cô Sáu', pickerPhone: '0909000666' });
      const tok = pushes.find((p) => p.payload.data.pickupRequestId === req0.id)!.payload.data.actionToken;
      expect((await request(http).post('/api/v1/push/actions').send({ token: tok, action: 'confirm', requestId: other.id }).expect(403)).body.code).toBe('INVALID_ACTION_TOKEN');
      // token signed with another secret
      const { JwtService } = require('@nestjs/jwt');
      const fake = new JwtService().sign({ typ: 'pickup_action', rid: req0.id, uid: s.users.ph1.id }, { secret: 'wrong' });
      await request(http).post('/api/v1/push/actions').send({ token: fake, action: 'confirm' }).expect(403);
      // a normal login token is not an action token
      await request(http).post('/api/v1/push/actions').send({ token: tokens.ph1, action: 'confirm' }).expect(403);
      expect((await as('admin').get(`/pickup-requests/${req0.id}`).expect(200)).body.parent.status).toBe('pending');
    });

    it('PK-B02 / B06: confirm right on the push -> parent step approved (channel push); twice -> 409', async () => {
      const tok = pushes.find((p) => p.payload.data.pickupRequestId === req0.id)!.payload.data.actionToken;
      const r = await request(http).post('/api/v1/push/actions').send({ token: tok, action: 'confirm', requestId: req0.id }).expect(200);
      expect(r.body).toMatchObject({ status: 'pending', parentStatus: 'approved', schoolStatus: 'pending', blockers: ['SCHOOL_PENDING'] });
      expect((await as('admin').get(`/pickup-requests/${req0.id}`).expect(200)).body.parent).toMatchObject({ status: 'approved', channel: 'push', decidedBy: s.users.ph1.id });
      await request(http).post('/api/v1/push/actions').send({ token: tok, action: 'reject' }).expect(409);
      // reject from push on another request
      pushes.length = 0;
      const r2 = await newReq(2, { pickerName: 'Bác Bảy', pickerPhone: '0909000777' });
      expect(pushes).toHaveLength(0); // kid 2 has no parent account
      const r3 = await newReq(0, { pickerName: 'Anh Tám', pickerPhone: '0909000888' });
      const t3 = pushes.find((p) => p.payload.data.pickupRequestId === r3.id)!.payload.data.actionToken;
      expect((await request(http).post('/api/v1/push/actions').send({ token: t3, action: 'reject' }).expect(200)).body).toMatchObject({ status: 'rejected', parentStatus: 'rejected' });
      expect(r2.status).toBe('pending');
    });

    it('PK-H02 (P1): failed push is logged, flow continues; 410 removes the subscription', async () => {
      pushFail = 410;
      const r = await newReq(0, { pickerName: 'Chị Chín', pickerPhone: '0909000999' });
      pushFail = null;
      expect(r.delivery.find((d: any) => d.channel === 'webpush')).toMatchObject({ failed: 1 });
      expect((await as('ph1').get('/push/subscriptions').expect(200)).body).toHaveLength(0);
      const [{ n }] = await ds.query(`SELECT COUNT(*)::int n FROM notification_deliveries WHERE ref_id = $1 AND channel = 'webpush' AND status = 'failed'`, [r.id]);
      expect(n).toBe(1);
      await as('ph1').post('/push/subscriptions', { endpoint: 'https://push.example.test/ph1', keys: { p256dh: 'BPk', auth: 'au' } }).expect(201);
    });
  });

  // ───────────── C / H. 15 minutes ─────────────
  describe('C/H. quá 15 phút chưa trả lời', () => {
    let r: any;
    it('PK-C01: before 15 minutes no call prompt', async () => {
      r = await newReq(0, { pickerName: 'Ông Mười', pickerPhone: '0909001010' });
      expect(r.escalation).toMatchObject({ afterMinutes: 15, due: false, promptCall: false, phones: [] });
      await ds.query(`UPDATE pickup_requests SET created_at = now() - interval '14 minutes 50 seconds' WHERE id = $1`, [r.id]);
      expect((await as('gv1').get(`/pickup-requests/${r.id}`).expect(200)).body.escalation.due).toBe(false);
    });

    it('PK-C02 / H01: at 15 minutes the teacher is prompted to call phone 1 then phone 2 (tel: links)', async () => {
      await ds.query(`UPDATE pickup_requests SET created_at = now() - interval '15 minutes' WHERE id = $1`, [r.id]);
      const v = (await as('gv1').get(`/pickup-requests/${r.id}`).expect(200)).body;
      expect(v.escalation).toMatchObject({ due: true, promptCall: true });
      expect(v.escalation.phones.map((p: any) => [p.order, p.phone, p.tel])).toEqual([[1, '0913000000', 'tel:0913000000'], [2, '0914000000', 'tel:0914000000']]);
      expect(v.escalation.nextPhone.phone).toBe('0913000000');
      // listed in the class list too
      expect((await as('gv1').get('/pickup-requests?status=pending').expect(200)).body.find((x: any) => x.id === r.id).escalation.due).toBe(true);
      // log a call to number 1 -> next is number 2
      const c = await as('gv1').post(`/pickup-requests/${r.id}/call-attempts`, { phone: '0913000000', outcome: 'no_answer' }).expect(201);
      expect(c.body.escalation.nextPhone.phone).toBe('0914000000');
      expect(c.body.escalation.callAttempts[0]).toMatchObject({ phone: '0913000000', outcome: 'no_answer', calledBy: s.users.gv1.id, calledByName: expect.any(String) });
      await as('gv2').post(`/pickup-requests/${r.id}/call-attempts`, { phone: '0913000000', outcome: 'no_answer' }).expect(403);
      await as('ph1').post(`/pickup-requests/${r.id}/call-attempts`, { phone: '0913000000', outcome: 'no_answer' }).expect(403);
    });

    it('PK-C03: never auto-handover / auto-confirm (after 15 min, a "confirmed" call, 2 hours, end of day)', async () => {
      const c = await as('gv1').post(`/pickup-requests/${r.id}/call-attempts`, { phone: '0914000000', outcome: 'confirmed', note: 'Mẹ bé nói đồng ý' }).expect(201);
      expect(c.body).toMatchObject({ status: 'pending', parent: { status: 'pending' }, school: { status: 'pending' }, readyForHandover: false });
      await ds.query(`UPDATE pickup_requests SET created_at = now() - interval '2 hours 1 minute', expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
      const v = (await as('gv1').get(`/pickup-requests/${r.id}`).expect(200)).body;
      expect(v).toMatchObject({ status: 'expired', parent: { status: 'pending' }, readyForHandover: false });
      expect(v.escalation.due).toBe(false);
      expect((await handover('gv1', 0, { pickupRequestId: r.id }, 403)).body.code).toBe('PICKUP_REQUEST_EXPIRED');
      const [{ n }] = await ds.query('SELECT COUNT(*)::int n FROM pickups WHERE attendance_id = $1', [await attId(0)]);
      expect(n).toBe(0);
    });

    it('PK-C04 (P1): parent answers after the prompt -> prompt gone', async () => {
      const r2 = await newReq(0, { pickerName: 'Cô Mười Một', pickerPhone: '0909001111' });
      await ds.query(`UPDATE pickup_requests SET created_at = now() - interval '20 minutes' WHERE id = $1`, [r2.id]);
      expect((await as('gv1').get(`/pickup-requests/${r2.id}`).expect(200)).body.escalation.due).toBe(true);
      await as('ph1').post(`/pickup-requests/${r2.id}/reject`, {}).expect(200);
      expect((await as('gv1').get(`/pickup-requests/${r2.id}`).expect(200)).body.escalation.due).toBe(false);
    });
  });

  // ───────────── contact phones (PM addition) ─────────────
  describe('số liên hệ của phụ huynh (2 số gọi khi quá 15 phút)', () => {
    it('P0: parent edits contact phones only for own child (other child / teacher -> 403)', async () => {
      await as('ph1').patch(`/children/${s.kids[1].id}/contact-phones`, { phone1: '0977000001' }).expect(403);
      await as('gv1').patch(`/children/${s.kids[0].id}/contact-phones`, { phone1: '0977000001' }).expect(403);
      await request(http).patch(`/api/v1/children/${s.kids[0].id}/contact-phones`).send({ phone1: '0977000001' }).expect(401);
      await as('ph1').patch(`/children/${s.kids[0].id}/contact-phones`, { phone1: 'abc' }).expect(400);
      await as('ph1').patch(`/children/${s.kids[0].id}/contact-phones`, { phone1: '0977000001', phone2: '0977 000 001' }).expect(400);
    });

    it('P1: change takes effect immediately in escalation, history kept, admin notified', async () => {
      const r = await newReq(0, { pickerName: 'Bà Sáu', pickerPhone: '0909016666' });
      await ds.query(`UPDATE pickup_requests SET created_at = now() - interval '16 minutes' WHERE id = $1`, [r.id]);
      expect((await as('gv1').get(`/pickup-requests/${r.id}`).expect(200)).body.escalation.phones.map((p: any) => p.phone)).toEqual(['0913000000', '0914000000']);
      const u = await as('ph1').patch(`/children/${s.kids[0].id}/contact-phones`, { phone1: '0977 000 001', phone2: '0913000000' }).expect(200);
      expect(u.body).toMatchObject({ childId: s.kids[0].id, phone1: '0977000001', phone2: '0913000000', updatedBy: s.users.ph1.id });
      expect(u.body.callOrder.map((p: any) => [p.order, p.phone, p.source])).toEqual([[1, '0977000001', 'contact'], [2, '0913000000', 'contact']]);
      const v = (await as('gv1').get(`/pickup-requests/${r.id}`).expect(200)).body;
      expect(v.escalation.phones.map((p: any) => [p.phone, p.tel])).toEqual([['0977000001', 'tel:0977000001'], ['0913000000', 'tel:0913000000']]);
      expect(v.escalation.nextPhone.phone).toBe('0977000001');
      // only phone1 -> phone 2 falls back to the guardians
      await as('ph1').patch(`/children/${s.kids[0].id}/contact-phones`, { phone1: '0977000002', phone2: '' }).expect(200);
      expect((await as('gv1').get(`/pickup-requests/${r.id}`).expect(200)).body.escalation.phones.map((p: any) => p.phone)).toEqual(['0977000002', '0913000000']);
      const h = await as('ph1').get(`/children/${s.kids[0].id}/contact-phones/history`).expect(200);
      expect(h.body.items.map((x: any) => [x.before, x.after, x.changedBy])).toEqual([
        [{ phone1: null, phone2: null }, { phone1: '0977000001', phone2: '0913000000' }, s.users.ph1.id],
        [{ phone1: '0977000001', phone2: '0913000000' }, { phone1: '0977000002', phone2: null }, s.users.ph1.id],
      ]);
      await as('ph2').get(`/children/${s.kids[0].id}/contact-phones/history`).expect(403);
      expect((await as('gv1').get(`/children/${s.kids[0].id}/contact-phones`).expect(200)).body.phone1).toBe('0977000002');
      const n = (await as('admin').get('/notifications').expect(200)).body.items.filter((x: any) => x.type === 'contact_change' && x.data.childId === s.kids[0].id);
      expect(n).toHaveLength(2);
      // restore the seed phones order for later tests
      await ds.query('UPDATE children SET contact_phone1 = NULL, contact_phone2 = NULL WHERE id = $1', [s.kids[0].id]);
    });

    it('request objects carry className and dueAt (createdAt + PICKUP_ESCALATE_MINUTES)', async () => {
      const f = (await as('ph1').get('/pickup-requests/feed').expect(200)).body.items[0];
      expect(f.className).toBe('Mầm 1');
      expect(new Date(f.dueAt).getTime() - new Date(f.createdAt).getTime()).toBe(15 * 60_000);
      const l = (await as('admin').get('/pickup-requests').expect(200)).body[0];
      expect(l).toMatchObject({ className: expect.any(String), dueAt: expect.any(String) });
    });
  });

  // ───────────── HEIC photos (PM addition) ─────────────
  describe('ảnh HEIC/HEIF', () => {
    // QA fixtures live in the mamnon-qa repo; HEIC_FIXTURE_DIR overrides, else sibling checkout, else the old /workspace/qa path
    const heicDir = [process.env.HEIC_FIXTURE_DIR, require('path').join(__dirname, '..', '..', 'mamnon-qa', 'heic'), '/workspace/qa/heic']
      .find((d) => d && require('fs').existsSync(d)) ?? '/workspace/qa/heic';
    const fx = (n: string) => require('fs').readFileSync(require('path').join(heicDir, n));
    it('real HEIC is accepted and stored as JPEG; fake .heic (exe / text) -> 400, for every photo upload', async () => {
      const ok = await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'Ảnh HEIC').field('relation', 'Cô').field('idNumber', '079000000777').field('phone1', '0911000777')
        .attach('photo', fx('that.heic'), { filename: 'that.heic', contentType: 'image/heic' }).expect(201);
      const img = await request(http).get(`/api/v1/authorized-pickers/${ok.body.id}/photo`).set('Authorization', `Bearer ${tokens.ph1}`).expect(200);
      expect(img.headers['content-type']).toBe('image/jpeg');
      expect([...img.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      for (const bad of ['gia_exe.heic', 'gia_txt.heic']) {
        expect((await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'Giả').field('relation', 'Cô').field('idNumber', '079000000778').field('phone1', '0911000778')
          .attach('photo', fx(bad), { filename: bad, contentType: 'image/heic' }).expect(400)).body.code).toBe('INVALID_FILE');
        await as('gv1').multipart(`/attendance/${await attId(0)}/pickup-requests`).field('pickerName', 'X').field('pickerPhone', '0909000000').field('note', 'n')
          .attach('photo', fx(bad), { filename: bad, contentType: 'image/heic' }).expect(400);
        await as('gv1').multipart(`/children/${s.kids[0].id}/photo`).attach('file', fx(bad), { filename: bad, contentType: 'image/heic' }).expect(400);
      }
      const rq = await as('gv1').multipart(`/attendance/${await attId(0)}/pickup-requests`).field('pickerName', 'HEIC').field('pickerPhone', '0909000001').field('note', 'n')
        .attach('photo', fx('that.heic'), { filename: 'that.heic', contentType: 'image/heic' }).expect(201);
      expect((await request(http).get(`/api/v1/pickup-requests/${rq.body.id}/photo`).set('Authorization', `Bearer ${tokens.ph1}`).expect(200)).headers['content-type']).toBe('image/jpeg');
      await ds.query(`UPDATE pickup_requests SET status = 'rejected', school_status = 'rejected' WHERE id = $1`, [rq.body.id]);
      const ch = await as('gv1').multipart(`/children/${s.kids[0].id}/photo`).attach('file', fx('that.heic'), { filename: 'that.heic', contentType: 'image/heic' });
      expect([200, 201]).toContain(ch.status);
      expect((await request(http).get(`/api/v1/children/${s.kids[0].id}/photo`).set('Authorization', `Bearer ${tokens.ph1}`).expect(200)).headers['content-type']).toBe('image/jpeg');
    });
  });

  // ───────────── D. two-step hand-over ─────────────
  describe('D. giao bé cần đủ 2 bước', () => {
    it('PK-D01 / D05: parent confirmed, school not -> pickup API 403', async () => {
      const b = (await handover('gv1', 0, { pickupRequestId: req0.id }, 403)).body;
      expect(b).toMatchObject({ code: 'PICKUP_REQUEST_PENDING', details: ['SCHOOL_PENDING'] });
    });

    it('PK-D02: school approved, parent not -> 403', async () => {
      const r = await newReq(1, { pickerName: 'Dì Hai', pickerPhone: '0909002222' });
      expect((await as('admin').post(`/pickup-requests/${r.id}/confirm`, {}).expect(200)).body).toMatchObject({ status: 'pending', school: { status: 'approved', role: 'admin' }, parent: { status: 'pending' } });
      expect((await handover('gv1', 1, { pickupRequestId: r.id }, 403)).body).toMatchObject({ code: 'PICKUP_REQUEST_PENDING', details: ['PARENT_PENDING'] });
      // admin approving the school step twice -> 409
      await as('admin').post(`/pickup-requests/${r.id}/confirm`, {}).expect(409);
    });

    it('PK-D06: teacher (even homeroom) approving the school step -> 403; accountant too', async () => {
      const r = await newReq(1, { pickerName: 'Dượng Ba', pickerPhone: '0909003333' });
      expect((await as('gv1').post(`/pickup-requests/${r.id}/confirm`, {}).expect(403)).body.code).toBe('NOT_ON_DUTY');
      await as('gv1').post(`/pickup-requests/${r.id}/reject`, { note: 'x' }).expect(403);
      await as('ketoan').post(`/pickup-requests/${r.id}/confirm`, {}).expect(403);
      await as('gv2').post(`/pickup-requests/${r.id}/confirm`, {}).expect(403);
    });

    it('PK-D03 / D07: both steps -> hand-over OK with time and who; twice -> 409', async () => {
      const r = await newReq(1, { pickerName: 'Bác Tư', pickerPhone: '0909004444' });
      await onBehalf(r.id);
      await as('admin').post(`/pickup-requests/${r.id}/confirm`, {}).expect(200);
      const opts = (await as('gv1').get(`/attendance/${await attId(1)}/pickup-options`).expect(200)).body;
      expect(opts.requests.find((x: any) => x.id === r.id)).toMatchObject({ canHandOver: true, blockers: [], readyForHandover: true });
      const h = await handover('gv1', 1, { pickupRequestId: r.id }, 201);
      expect(h.body).toMatchObject({ pickedUpByName: 'Bác Tư', pickupRequestId: r.id, pickerKind: 'request', handedOverBy: s.users.gv1.id, recordedBy: s.users.gv1.id, pickedUpAt: expect.any(String) });
      expect((await handover('gv1', 1, { pickupRequestId: r.id }, 409)).body.code).toBe('ALREADY_PICKED_UP');
      const day = (await as('gv1').get(`/classes/${s.classes.c1.id}/attendance?date=${todayStr()}`).expect(200)).body;
      expect(day.items.find((x: any) => x.childId === c1Kids[1].id).pickup).toBeTruthy();
    });

    it('PK-D04 (+E02): parent confirmed then school rejected (note required), or reverse -> no hand-over', async () => {
      const r = await newReq(2, { pickerName: 'Anh Năm', pickerPhone: '0909005555' });
      await onBehalf(r.id);
      expect((await as('admin').post(`/pickup-requests/${r.id}/reject`, {}).expect(400)).body.code).toBe('NOTE_REQUIRED');
      expect((await as('admin').post(`/pickup-requests/${r.id}/reject`, { note: 'Không xác minh được' }).expect(200)).body).toMatchObject({ status: 'rejected', school: { status: 'rejected', note: 'Không xác minh được' } });
      expect((await handover('gv1', 2, { pickupRequestId: r.id }, 403)).body.code).toBe('PICKUP_REQUEST_REJECTED');
      const r2 = await newReq(2, { pickerName: 'Chị Sáu', pickerPhone: '0909006666' });
      await as('admin').post(`/pickup-requests/${r2.id}/confirm`, {}).expect(200);
      await as('admin').post(`/pickup-requests/${r2.id}/parent-decision`, { decision: 'reject', note: 'Mẹ bé nói không quen' }).expect(200);
      expect((await handover('gv1', 2, { pickupRequestId: r2.id }, 403)).body.code).toBe('PICKUP_REQUEST_REJECTED');
    });

    it('PK-D09: both steps done but expired before hand-over -> 403', async () => {
      const r = await newReq(3, { pickerName: 'Ông Bảy', pickerPhone: '0909007777' });
      await onBehalf(r.id);
      await as('admin').post(`/pickup-requests/${r.id}/confirm`, {}).expect(200);
      await ds.query(`UPDATE pickup_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [r.id]);
      expect((await handover('gv1', 3, { pickupRequestId: r.id }, 403)).body.code).toBe('PICKUP_REQUEST_EXPIRED');
    });

    it('PK-D08b: picker registered but not yet approved = off-list -> 403', async () => {
      expect((await handover('gv1', 0, { authorizedPickerId: pickerId }, 403)).body.code).toBe('PICKER_NOT_APPROVED');
      const opts = (await as('gv1').get(`/attendance/${await attId(0)}/pickup-options`).expect(200)).body;
      expect(opts.authorizedPickers.find((p: any) => p.id === pickerId)).toMatchObject({ canHandOver: false, blockers: ['NOT_APPROVED_YET'], idNumberMasked: '********6789' });
      expect(JSON.stringify(opts)).not.toContain(CCCD);
    });

    it('PK-D10: hand-over screen shows the full CCCD + photo to the class teacher, audit-logged', async () => {
      const a = await attId(0);
      const r = await as('gv1').get(`/attendance/${a}/pickup-identity?kind=authorized_picker&id=${pickerId}`).expect(200);
      expect(r.body).toMatchObject({ idNumber: CCCD, fullName: 'Trần Văn Tư', photoUrl: `/api/v1/authorized-pickers/${pickerId}/photo`, audited: true });
      const q = await as('admin').get(`/attendance/${a}/pickup-identity?kind=pickup_request&id=${req0.id}`).expect(200);
      expect(q.body.idNumber).toBe('079555555555');
      const logs = await ds.query(`SELECT user_id, entity_type, entity_id, purpose, field FROM sensitive_access_logs WHERE attendance_id = $1 ORDER BY created_at`, [a]);
      expect(logs).toEqual([
        { user_id: s.users.gv1.id, entity_type: 'authorized_picker', entity_id: pickerId, purpose: 'handover', field: 'id_number' },
        { user_id: s.users.admin.id, entity_type: 'pickup_request', entity_id: req0.id, purpose: 'handover', field: 'id_number' },
      ]);
    });

    it('PK-D08: approved picker / parent -> direct hand-over; parent notified "Bé đã được X đón lúc HH:MM"', async () => {
      await as('ph1').post(`/authorized-pickers/${pickerId}/approve`, {}).expect(403);
      expect((await as('admin').post(`/authorized-pickers/${pickerId}/reject`, {}).expect(400)).body.code).toBe('NOTE_REQUIRED');
      expect((await as('admin').post(`/authorized-pickers/${pickerId}/approve`, {}).expect(200)).body).toMatchObject({ status: 'approved', onList: true, decidedBy: s.users.admin.id });
      expect((await as('ph1').get('/notifications').expect(200)).body.items.some((n: any) => n.type === 'picker_decision')).toBe(true);
      pushes.length = 0;
      const h = await handover('gv1', 0, { authorizedPickerId: pickerId }, 201);
      expect(h.body).toMatchObject({ pickerKind: 'authorized_picker', authorizedPickerId: pickerId, pickedUpByName: 'Trần Văn Tư', relation: 'Chú ruột' });
      const n = (await as('ph1').get('/notifications').expect(200)).body.items.find((x: any) => x.type === 'picked_up');
      expect(n.body).toMatch(/^Chú ruột Trần Văn Tư đón lúc \d\d:\d\d, .+ giao\.$/);
      expect(n.title).toMatch(/^🚸 Bé \S+ đã được đón$/);
      expect(pushes.find((p) => p.endpoint.endsWith('/ph1'))!.payload.body).toBe(n.body);
      expect((await as('ph2').get('/notifications').expect(200)).body.items.some((x: any) => x.type === 'picked_up')).toBe(false);
      // guardian (parent) of another child: direct
      const k = c1Kids[8];
      const dad = (await as('admin').get(`/children/${k.id}/guardians`).expect(200)).body.find((g: any) => g.relation === 'Bố');
      expect((await handover('gv1', 8, { guardianId: dad.id }, 201)).body).toMatchObject({ pickerKind: 'guardian', guardianId: dad.id });
    });

    it('rejected picker -> 403', async () => {
      const r = await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'X').field('relation', 'Bạn').field('idNumber', '079000000009').field('phone1', '0911000009')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
      await as('admin').post(`/authorized-pickers/${r.body.id}/reject`, { note: 'Không đủ giấy tờ' }).expect(200);
      await as('admin').post(`/authorized-pickers/${r.body.id}/approve`, {}).expect(409);
      expect((await handover('gv1', 9, { authorizedPickerId: r.body.id }, 400)).body.code).toBe('INVALID_AUTHORIZED_PICKER'); // another child's attendance
    });
  });

  // ───────────── E. warnings ─────────────
  describe('E. cảnh báo', () => {
    it('PK-E03/E04 (P1): same person (phone / CCCD) for ≥2 children today -> warning with relation, not blocking', async () => {
      const a = await newReq(6, { pickerName: 'Cô Út', pickerPhone: '0909888888', relation: 'Cô ruột' });
      expect(a.warnings).toEqual([]);
      const b = await newReq(7, { pickerName: 'Cô Út', pickerPhone: '0909 888 888', relation: 'Cô ruột' });
      expect(b.warnings[0]).toMatchObject({ code: 'SAME_PICKER_MULTIPLE_CHILDREN', children: [expect.objectContaining({ childId: c1Kids[6].id, relation: 'Cô ruột' })] });
      await onBehalf(b.id);
      await as('admin').post(`/pickup-requests/${b.id}/confirm`, {}).expect(200);
      const h = await handover('gv1', 7, { pickupRequestId: b.id }, 201);
      expect(h.body.warnings[0].code).toBe('SAME_PICKER_MULTIPLE_CHILDREN');
    });
  });

  // ───────────── G. duty roster ─────────────
  describe('G. tài khoản trực đón', () => {
    it('PK-G04: non-admin cannot assign duty -> 403', async () => {
      await as('gv1').post('/pickup-duties', { userId: s.users.gv1.id, dates: [todayStr()] }).expect(403);
      await as('ketoan').post('/pickup-duties', { userId: s.users.ketoan.id, dates: [todayStr()] }).expect(403);
      await as('ph1').post('/pickup-duties', { userId: s.users.ph1.id, dates: [todayStr()] }).expect(403);
      expect((await as('admin').post('/pickup-duties', { userId: s.users.ph1.id, dates: [todayStr()] }).expect(400)).body.code).toBe('INVALID_DUTY_USER');
    });

    it('PK-G01 (+G05): admin assigns X (gv2) for today -> X approves today\'s request (role duty recorded)', async () => {
      const d = await as('admin').post('/pickup-duties', { userId: s.users.gv2.id, dates: [todayStr(), todayStr()], note: 'Trực chiều' }).expect(201);
      expect(d.body).toHaveLength(1);
      expect((await as('gv2').get('/pickup-duties/me').expect(200)).body).toMatchObject({ onDutyToday: true, canApproveToday: true });
      const r = await newReq(5, { pickerName: 'Bà Ngoại Hai', pickerPhone: '0909555000' });
      // duty account sees today's requests (other class) and the photo
      expect((await as('gv2').get('/pickup-requests?status=pending').expect(200)).body.map((x: any) => x.id)).toContain(r.id);
      await as('gv2').get(`/pickup-requests/${r.id}/photo`).expect(200);
      expect((await as('gv2').post(`/pickup-requests/${r.id}/confirm`, {}).expect(200)).body).toMatchObject({ school: { status: 'approved', role: 'duty', decidedBy: s.users.gv2.id, decidedByName: expect.any(String) } });
      await onBehalf(r.id);
      expect((await handover('gv1', 5, { pickupRequestId: r.id }, 201)).body.pickerKind).toBe('request');
      // the list of duties: admin sees all, others only own
      expect((await as('admin').get('/pickup-duties').expect(200)).body.some((x: any) => x.userId === s.users.gv2.id && x.date === todayStr())).toBe(true);
      expect((await as('gv3').get('/pickup-duties').expect(200)).body).toHaveLength(0);
    });

    it('PK-G02: duty for another day / request of another day -> 403', async () => {
      await as('admin').post('/pickup-duties', { userId: s.users.gv3.id, dates: [addDays(todayStr(), 1)] }).expect(201);
      const r = await newReq(4, { pickerName: 'Chú Chín', pickerPhone: '0909009999' });
      expect((await as('gv3').post(`/pickup-requests/${r.id}/confirm`, {}).expect(403)).body.code).toBe('NOT_ON_DUTY');
      // yesterday's request: gv2 is on duty today, not yesterday
      const [y] = await ds.query(`SELECT id FROM attendance WHERE child_id = $1 AND date = $2`, [s.kids[1].id, addDays(todayStr(), -1)]);
      const [old] = await ds.query(`INSERT INTO pickup_requests (attendance_id, child_id, class_id, picker_name, picker_phone, note, status, parent_status, school_status, requested_by, expires_at)
        VALUES ($1, $2, $3, 'Người hôm qua', '0909111222', 'x', 'pending', 'pending', 'pending', $4, now() + interval '1 hour') RETURNING id`, [y.id, s.kids[1].id, s.kids[1].classId, s.users.gv2.id]);
      expect((await as('gv2').post(`/pickup-requests/${old.id}/confirm`, {}).expect(403)).body.code).toBe('NOT_ON_DUTY');
      // duty removed -> 403 again
      const mine = (await as('admin').get(`/pickup-duties?userId=${s.users.gv2.id}`).expect(200)).body;
      await as('gv2').del(`/pickup-duties/${mine[0].id}`).expect(403);
      await as('admin').del(`/pickup-duties/${mine[0].id}`).expect(204);
      await as('gv2').post(`/pickup-requests/${r.id}/confirm`, {}).expect(403);
    });

    it('PK-G03: homeroom teacher on duty approves -> must not hand over herself; someone else can', async () => {
      await as('admin').post('/pickup-duties', { userId: s.users.gv1.id, dates: [todayStr()] }).expect(201);
      const r = await newReq(4, { pickerName: 'Chú Chín', pickerPhone: '0909009999' }).catch(() => null);
      const list = (await as('gv1').get(`/pickup-requests?childId=${c1Kids[4].id}&status=pending`).expect(200)).body;
      const target = r ?? list[0];
      expect((await as('gv1').post(`/pickup-requests/${target.id}/confirm`, {}).expect(200)).body.school).toMatchObject({ status: 'approved', role: 'duty' });
      await onBehalf(target.id);
      const opts = (await as('gv1').get(`/attendance/${await attId(4)}/pickup-options`).expect(200)).body;
      expect(opts.requests.find((x: any) => x.id === target.id)).toMatchObject({ canHandOver: false, blockers: ['YOU_APPROVED'] });
      expect((await handover('gv1', 4, { pickupRequestId: target.id }, 403)).body.code).toBe('APPROVER_CANNOT_HAND_OVER');
      expect((await handover('admin', 4, { pickupRequestId: target.id }, 201)).body.handedOverBy).toBe(s.users.admin.id);
    });
  });

  describe('hotfix/import integration', () => {
    it('same person = same phone + same name (NFC / case / spaces) -> 409; names stored NFC', async () => {
      const nfd = 'Phạm  Thị   Hằng'.normalize('NFD');
      const a = await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', nfd).field('relation', 'Dì').field('idNumber', '079000000881').field('phone1', '0911000881')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
      expect(a.body.fullName).toBe('Phạm Thị Hằng'.normalize('NFC'));
      expect((await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'phạm thị hằng').field('relation', 'Dì').field('idNumber', '079000000882').field('phone1', '0911000881')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(409)).body.code).toBe('DUPLICATE_PICKER');
      // diacritics differ -> a different person
      await as('ph1').multipart(`/children/${s.kids[0].id}/authorized-pickers`).field('fullName', 'Pham Thi Hang').field('relation', 'Dì').field('idNumber', '079000000883').field('phone1', '0911000881')
        .attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
    });

    it('deleting a guardian keeps past pickups (guardian_id -> NULL, name kept) and drops it from the call list', async () => {
      const k = c1Kids[9];
      const gs = (await as('admin').get(`/children/${k.id}/guardians`).expect(200)).body;
      const mom = gs.find((g: any) => g.relation === 'Mẹ');
      const p = (await handover('gv1', 9, { guardianId: mom.id }, 201)).body;
      await as('admin').del(`/children/${k.id}/guardians/${mom.id}`, { reason: 'Nhập nhầm' }).expect(200);
      const [row] = await ds.query('SELECT guardian_id, picked_up_by_name, picker_kind FROM pickups WHERE id = $1', [p.id]);
      expect(row).toEqual({ guardian_id: null, picked_up_by_name: mom.fullName, picker_kind: 'guardian' });
      const day = (await as('gv1').get(`/classes/${s.classes.c1.id}/attendance?date=${todayStr()}`).expect(200)).body;
      expect(day.items.find((x: any) => x.childId === k.id).pickup).toMatchObject({ pickedUpByName: mom.fullName });
      const opts = (await as('gv1').get(`/attendance/${await attId(9)}/pickup-options`).expect(200)).body;
      expect(opts.guardians.map((g: any) => g.id)).not.toContain(mom.id);
    });
  });
});
