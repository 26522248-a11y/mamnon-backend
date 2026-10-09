process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
process.env.NOTIFY_CHANNELS = 'inapp';
delete process.env.BANK_BIN; delete process.env.BANK_ACCOUNT_NO; delete process.env.BANK_ACCOUNT_NAME;

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { seed } from '../src/database/seed';
import { contentMatches, crc16, vietQrPayload } from '../src/fees/vietqr';

/** Parses an EMVCo TLV string into {id: value}. */
const tlvParse = (s: string) => {
  const out: Record<string, string> = {};
  for (let i = 0; i < s.length;) { const id = s.slice(i, i + 2), n = Number(s.slice(i + 2, i + 4)); out[id] = s.slice(i + 4, i + 4 + n); i += 4 + n; }
  return out;
};

describe('round 3: QR payments + transfer claims (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const H = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set(H(who)),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(H(who)).send(body),
  });
  const notes = async (username: string, type: string) =>
    ds.query(`SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = $1 AND n.type = $2 ORDER BY n.created_at`, [username, type]);
  const audits = (action: string, entityId: string) => ds.query(`SELECT * FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY created_at`, [action, entityId]);
  const period = '2027-03';
  const inv: Record<number, any> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'ph1', 'ph2', 'ketoan']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    await as('ketoan').post('/invoices/generate', { period, classId: s.classes.c1.id }).expect(201);
    const items = (await as('ketoan').get(`/invoices?period=${period}&limit=100`).expect(200)).body.items;
    for (const k of [0, 3, 6, 9, 12]) inv[k] = items.find((i: any) => i.childId === s.kids[k].id);
    for (const k of [0, 3, 6, 9, 12]) expect(inv[k]?.totalAmount).toBeGreaterThan(100000);
  });
  afterAll(async () => { delete process.env.BANK_BIN; delete process.env.BANK_ACCOUNT_NO; delete process.env.BANK_ACCOUNT_NAME; process.env.NODE_ENV = 'test'; await app?.close(); });

  it('VietQR payload: EMVCo TLV, NAPAS GUID, amount, content, CRC16', () => {
    expect(crc16('123456789')).toBe('29B1'); // CRC-16/CCITT-FALSE check value
    const p = vietQrPayload({ bin: '970436', accountNo: '0071000123456', amount: 3050000, content: 'HD202611-00042' });
    const t = tlvParse(p);
    expect(t).toMatchObject({ '00': '01', '01': '12', '53': '704', '54': '3050000', '58': 'VN' });
    expect(tlvParse(t['38'])).toMatchObject({ '00': 'A000000727', '02': 'QRIBFTTA' });
    expect(tlvParse(tlvParse(t['38'])['01'])).toEqual({ '00': '970436', '01': '0071000123456' });
    expect(tlvParse(t['62'])['08']).toBe('HD202611-00042');
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
    expect(contentMatches('CK HD20261100042 be An', 'HD202611-00042')).toBe(true);
  });

  it('QR-01/02/04: amount = owed, content = invoice code, sample when bank env missing, 403 for others', async () => {
    const i = inv[0];
    expect((await as('ph1').get('/settings/school').expect(200)).body.bankTransfer).toEqual({ enabled: true, sample: true });
    const q = (await as('ph1').get(`/invoices/${i.id}/qr`).expect(200)).body;
    expect(q).toMatchObject({ invoiceId: i.id, invoiceNo: i.invoiceNo, amount: i.totalAmount - i.paidAmount, transferContent: i.invoiceNo, sample: true, pendingClaim: null });
    expect(tlvParse(q.payload)['54']).toBe(String(q.amount));
    expect(tlvParse(tlvParse(q.payload)['62'])['08']).toBe(i.invoiceNo);
    await as('ph2').get(`/invoices/${i.id}/qr`).expect(403);
    await as('gv1').get(`/invoices/${i.id}/qr`).expect(403);
    await as('ketoan').get(`/invoices/${i.id}/qr`).expect(200);
    // real account configured
    Object.assign(process.env, { BANK_BIN: '970415', BANK_ACCOUNT_NO: '113366668888', BANK_ACCOUNT_NAME: 'TRUONG MAM NON NHU Y' });
    const real = (await as('ph1').get(`/invoices/${i.id}/qr`).expect(200)).body;
    expect(real).toMatchObject({ sample: false, bank: { bin: '970415', accountNo: '113366668888', accountName: 'TRUONG MAM NON NHU Y' } });
    expect(tlvParse(tlvParse(tlvParse(real.payload)['38'])['01'])).toEqual({ '00': '970415', '01': '113366668888' });
    expect((await as('ph1').get('/settings/school').expect(200)).body.bankTransfer).toEqual({ enabled: true, sample: false });
    process.env.NODE_ENV = 'production'; // configured → fine in production
    await as('ph1').get(`/invoices/${i.id}/qr`).expect(200);
    delete process.env.BANK_BIN; delete process.env.BANK_ACCOUNT_NO; delete process.env.BANK_ACCOUNT_NAME;
    try {
      // production without bank: never a sample
      const r = (await as('ph1').get(`/invoices/${i.id}/qr`).expect(409)).body;
      const phone = (await as('ph1').get('/settings/school').expect(200)).body.phone;
      expect(r).toMatchObject({ code: 'BANK_ACCOUNT_NOT_CONFIGURED' });
      expect(r.details).toEqual({ schoolPhone: phone });
      expect((await as('ph1').get('/settings/school').expect(200)).body.bankTransfer).toEqual({ enabled: false, sample: false });
    } finally { process.env.NODE_ENV = 'test'; }
  });

  it('QR-05/06: "Tôi đã chuyển" → pending_confirmation only (never paid), idempotent, staff notified, audited', async () => {
    const i = inv[0];
    const r1 = (await as('ph1').post(`/invoices/${i.id}/transfer-claims`, {}).expect(201)).body;
    expect(r1).toMatchObject({ created: true, claim: { invoiceId: i.id, status: 'pending_confirmation', amount: i.totalAmount, onBehalf: false } });
    const r2 = (await as('ph1').post(`/invoices/${i.id}/transfer-claims`, { amount: 5 }).expect(200)).body;
    expect(r2).toMatchObject({ created: false, claim: { id: r1.claim.id, amount: i.totalAmount } });
    expect((await ds.query(`SELECT COUNT(*)::int n FROM transfer_claims WHERE invoice_id = $1`, [i.id]))[0].n).toBe(1);
    const v = (await as('ph1').get(`/invoices/${i.id}`).expect(200)).body;
    expect(v).toMatchObject({ status: 'unpaid', paidAmount: 0, balance: i.totalAmount, paymentStatus: 'pending_confirmation', transferClaim: { id: r1.claim.id } });
    expect((await as('ph1').get(`/invoices?period=${period}`).expect(200)).body.items[0]).toMatchObject({ id: i.id, paymentStatus: 'pending_confirmation' });
    expect((await as('ph1').get(`/invoices/${i.id}/qr`).expect(200)).body.pendingClaim).toMatchObject({ id: r1.claim.id });
    expect(await notes('ketoan', 'transfer_claim')).toHaveLength(1);
    expect(await notes('admin', 'transfer_claim')).toHaveLength(1);
    expect(await audits('transfer_claim.create', r1.claim.id)).toHaveLength(1);
    await as('ph2').post(`/invoices/${i.id}/transfer-claims`, {}).expect(403);
    await as('gv1').post(`/invoices/${i.id}/transfer-claims`, {}).expect(403);
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await as('ph1').post(`/invoices/${inv[12].id}/transfer-claims`, { transferredAt: future }).expect(400)).body.code).toBe('TRANSFERRED_AT_IN_FUTURE');
  });

  it('QR-07/08: reject with reason (parent told, audited); only accountant/admin decide', async () => {
    const i = inv[0];
    const c = (await as('ketoan').get('/transfer-claims?status=pending_confirmation').expect(200)).body.items.find((x: any) => x.invoiceId === i.id);
    expect(c).toMatchObject({ invoiceNo: i.invoiceNo, amountDue: i.totalAmount, difference: 0, childName: expect.any(String), className: 'Mầm 1' });
    await as('ph1').get('/transfer-claims').expect(403);
    for (const who of ['gv1', 'ph1']) {
      await as(who).post(`/transfer-claims/${c.id}/confirm`, {}).expect(403);
      await as(who).post(`/transfer-claims/${c.id}/reject`, { reason: 'x' }).expect(403);
    }
    expect((await as('ketoan').post(`/transfer-claims/${c.id}/reject`, { reason: '  ' }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    await as('ketoan').post(`/transfer-claims/${c.id}/reject`, {}).expect(400);
    const r = (await as('ketoan').post(`/transfer-claims/${c.id}/reject`, { reason: 'Chưa thấy tiền về tài khoản' }).expect(200)).body;
    expect(r.claim).toMatchObject({ status: 'rejected', rejectReason: 'Chưa thấy tiền về tài khoản', decidedBy: { name: expect.any(String) } });
    expect((await as('ketoan').post(`/transfer-claims/${c.id}/reject`, { reason: 'again' }).expect(409)).body.code).toBe('CLAIM_ALREADY_DECIDED');
    expect((await as('ketoan').post(`/transfer-claims/${c.id}/confirm`, {}).expect(409)).body.code).toBe('CLAIM_ALREADY_DECIDED');
    const pn = await notes('ph1', 'transfer_claim_rejected');
    expect(pn).toHaveLength(1);
    expect(pn[0]).toMatchObject({ important: true });
    expect(pn[0].body).toContain('Chưa thấy tiền về tài khoản');
    const [ev] = await audits('transfer_claim.reject', c.id);
    expect(ev).toMatchObject({ reason: 'Chưa thấy tiền về tài khoản', actor_username: 'ketoan' });
    expect(ev.before.status).toBe('pending_confirmation');
    expect(ev.after.status).toBe('rejected');
    const v = (await as('ph1').get(`/invoices/${i.id}`).expect(200)).body;
    expect(v).toMatchObject({ status: 'unpaid', paidAmount: 0, paymentStatus: null, transferClaim: { status: 'rejected' } });
  });

  it('QR-07/09: confirm creates a receipt; shortfall stays as debt', async () => {
    const i = inv[0];
    const c = (await as('ph1').post(`/invoices/${i.id}/transfer-claims`, { note: 'CK Vietcombank' }).expect(201)).body.claim; // new claim after rejection
    const got = i.totalAmount - 100000;
    const r = (await as('ketoan').post(`/transfer-claims/${c.id}/confirm`, { amount: got }).expect(200)).body;
    expect(r.claim).toMatchObject({ status: 'confirmed', paymentId: r.receipt.paymentId, receiptNo: r.receipt.receiptNo });
    expect(r.receipt).toMatchObject({ method: 'transfer', amount: got, appliedToInvoice: got, creditAdded: 0, invoice: { status: 'partial', balanceAfter: 100000 } });
    const v = (await as('ph1').get(`/invoices/${i.id}`).expect(200)).body;
    expect(v).toMatchObject({ status: 'partial', paidAmount: got, balance: 100000, paymentStatus: null, transferClaim: { status: 'confirmed' } });
    expect((await as('ph1').get(`/invoices/${i.id}/qr`).expect(200)).body.amount).toBe(100000);
    const pn = await notes('ph1', 'payment');
    expect(pn[pn.length - 1].body).toContain(r.receipt.receiptNo);
    const [ev] = await audits('transfer_claim.confirm', c.id);
    expect(ev.after).toMatchObject({ status: 'confirmed', receiptNo: r.receipt.receiptNo, receivedAmount: got });
    expect((await as('ketoan').get('/transfer-claims?status=confirmed').expect(200)).body.items.map((x: any) => x.id)).toContain(c.id);
  });

  it('QR-09: overpayment → credit; admin files on behalf', async () => {
    const i = inv[3];
    const c = (await as('admin').post(`/invoices/${i.id}/transfer-claims`, { amount: i.totalAmount + 50000 }).expect(201)).body.claim;
    expect(c).toMatchObject({ onBehalf: true });
    const list = (await as('ketoan').get('/transfer-claims?status=pending_confirmation').expect(200)).body.items;
    expect(list.find((x: any) => x.id === c.id).difference).toBe(50000);
    const r = (await as('admin').post(`/transfer-claims/${c.id}/confirm`, {}).expect(200)).body;
    expect(r.receipt).toMatchObject({ amount: i.totalAmount + 50000, creditAdded: 50000, invoice: { status: 'paid', balanceAfter: 0 } });
    expect((await as('ketoan').get(`/invoices/${i.id}/qr`).expect(409)).body.code).toBe('ALREADY_PAID'); // QR-03
    await as('ph1').get(`/invoices/${i.id}/qr`).expect(403); // not ph1's child: 403 wins over 409
  });

  it('QR-03 + side rules: void auto-rejects a pending claim; paid meanwhile → 409 on confirm', async () => {
    await as('ph2').get(`/invoices/${inv[6].id}/qr`).expect(403);
    const c = (await as('admin').post(`/invoices/${inv[6].id}/transfer-claims`, {}).expect(201)).body.claim;
    await as('ketoan').post(`/invoices/${inv[6].id}/void`, { reason: 'Lập nhầm' }).expect(200);
    const after = (await ds.query(`SELECT status, reject_reason FROM transfer_claims WHERE id = $1`, [c.id]))[0];
    expect(after).toEqual({ status: 'rejected', reject_reason: 'Hoá đơn đã huỷ' });
    expect((await audits('transfer_claim.reject', c.id))[0].data).toMatchObject({ auto: true });
    expect((await as('ketoan').get(`/invoices/${inv[6].id}/qr`).expect(409)).body.code).toBe('INVOICE_VOID');
    expect((await as('ketoan').post(`/invoices/${inv[6].id}/transfer-claims`, {}).expect(409)).body.code).toBe('INVOICE_VOID');
    // claim, then the accountant records cash for the full amount → confirming the claim must not double-count
    const c2 = (await as('ketoan').post(`/invoices/${inv[9].id}/transfer-claims`, {}).expect(201)).body.claim;
    await as('ketoan').post(`/invoices/${inv[9].id}/payments`, { amount: inv[9].totalAmount, method: 'cash' }).expect(201);
    expect((await as('ketoan').post(`/transfer-claims/${c2.id}/confirm`, {}).expect(409)).body.code).toBe('ALREADY_PAID');
    expect((await ds.query(`SELECT status FROM transfer_claims WHERE id = $1`, [c2.id]))[0].status).toBe('pending_confirmation');
    expect((await as('ketoan').post(`/invoices/${inv[9].id}/transfer-claims`, {}).expect(409)).body.code).toBe('ALREADY_PAID');
    await as('ketoan').post(`/transfer-claims/${c2.id}/reject`, { reason: 'Đã thu tiền mặt' }).expect(200);
  });
});
