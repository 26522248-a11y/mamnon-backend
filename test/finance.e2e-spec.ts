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
import { todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';
import { asciiFileName, contentDisposition, decodeOriginalName } from '../src/common/upload';

/** Thu chi tổng: học phí tự cộng từ phiếu thu, chi theo nhóm + hoá đơn, chi > 10tr chờ BGH duyệt; chỉ BGH + kế toán. */
describe('Finance (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  const tokens: Record<string, string> = {};
  const as = (who: string) => ({
    get: (url: string) => request(http).get('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: any) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    upload: (url: string) => request(http).post('/api/v1' + url).set('Authorization', `Bearer ${tokens[who]}`),
  });
  const T = todayStr(), M = T.slice(0, 7);
  const [y, mo] = M.split('-').map(Number);
  const PM = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'); // valid 1×1 PNG (B31 re-encodes uploads, so fixtures must decode)
  let cat: Record<string, string> = {};
  const feeSum = async (month: string) => Number((await ds.query(
    `SELECT COALESCE(SUM(amount),0)::bigint AS s FROM payments WHERE to_char(paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') = $1`, [month]))[0].s);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    await seed(ds);
    await ds.query('TRUNCATE finance_entries');
    await ds.query(`DELETE FROM finance_categories WHERE name NOT IN ('Lương & BH','Tiền ăn','Điện nước','Đồ dùng học tập','Sửa chữa, bảo trì','Chi khác','Thu khác')`);
    for (const u of ['admin', 'gv1', 'ketoan', 'ph1']) tokens[u] = (await request(http).post('/api/v1/auth/login').send({ username: u, password: '123456' })).body.accessToken;
    cat = Object.fromEntries((await as('admin').get('/finance/categories').expect(200)).body.items.map((c: any) => [c.name, c.id]));
  });
  afterAll(async () => { await app?.close(); });

  it('access: teachers and parents are forbidden everywhere; accountant cannot manage categories', async () => {
    for (const who of ['gv1', 'ph1']) {
      await as(who).get('/finance/summary').expect(403);
      await as(who).get('/finance/transactions').expect(403);
      await as(who).get('/finance/categories').expect(403);
      await as(who).post('/finance/entries', { date: T, title: 'X', amount: 100000, categoryId: cat['Chi khác'] }).expect(403);
    }
    expect(Object.keys(cat)).toEqual(expect.arrayContaining(['Lương & BH', 'Tiền ăn', 'Điện nước', 'Đồ dùng học tập', 'Thu khác']));
    await as('ketoan').get('/finance/summary').expect(200);
    await as('ketoan').post('/finance/categories', { kind: 'out', name: 'Văn phòng phẩm' }).expect(403);
    const c = (await as('admin').post('/finance/categories', { kind: 'out', name: 'Văn phòng phẩm' }).expect(201)).body;
    await as('admin').post('/finance/categories', { kind: 'out', name: 'Văn phòng phẩm' }).expect(409);
    expect((await as('admin').patch(`/finance/categories/${c.id}`, { isActive: false }).expect(200)).body.isActive).toBe(false);
    expect((await as('admin').post('/finance/entries', { date: T, title: 'Bút', amount: 50000, categoryId: c.id }).expect(400)).body.code).toBe('INVALID_CATEGORY');
  });

  it('expenses: categories, receipt upload, validation', async () => {
    const e = (await as('ketoan').upload('/finance/entries').field('date', T).field('title', 'Mua rau, thịt tuần 2').field('amount', '6200000').field('categoryId', cat['Tiền ăn'])
      .attach('receipt', PNG, 'hoa-don.png').expect(201)).body;
    expect(e).toMatchObject({ kind: 'out', status: 'approved', pending: false, amount: 6200000, hasReceipt: true, receiptName: 'hoa-don.png', category: { name: 'Tiền ăn' }, createdBy: { username: 'ketoan' } });
    const img = await as('admin').get(`/finance/entries/${e.id}/receipt`).expect(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/); // B31: image receipts stored as resized JPEG
    // attach a PDF to another entry
    const e2 = (await as('ketoan').post('/finance/entries', { date: T, title: 'Tiền điện T9', amount: 5100000, categoryId: cat['Điện nước'] }).expect(201)).body;
    expect(e2.hasReceipt).toBe(false);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    expect((await as('ketoan').upload(`/finance/entries/${e2.id}/receipt`).attach('receipt', pdf, 'dien.pdf').expect(200)).body).toMatchObject({ hasReceipt: true, receiptName: 'dien.pdf' });
    expect((await as('ketoan').get(`/finance/entries/${e2.id}/receipt`).expect(200)).headers['content-type']).toMatch(/application\/pdf/);
    expect((await as('ketoan').upload(`/finance/entries/${e2.id}/receipt`).attach('receipt', Buffer.from('hello'), 'x.pdf').expect(400)).body.code).toBe('INVALID_FILE');
    // B29: Vietnamese file name survives upload (UTF-8, not latin1 mojibake) and download (RFC 5987 + ASCII fallback)
    const vn = 'hóa đơn điện.pdf';
    const up = (await as('ketoan').upload(`/finance/entries/${e2.id}/receipt`).attach('receipt', pdf, vn).expect(200)).body;
    expect(up).toMatchObject({ hasReceipt: true, receiptName: vn });
    expect((await ds.query(`SELECT receipt_name FROM finance_entries WHERE id = $1`, [e2.id]))[0].receipt_name).toBe(vn);
    expect((await as('admin').get('/finance/transactions').expect(200)).body.items.find((x: any) => x.id === e2.id)?.receiptName ?? vn).toBe(vn);
    const dl = await as('ketoan').get(`/finance/entries/${e2.id}/receipt`).expect(200);
    expect(dl.headers['content-type']).toMatch(/application\/pdf/);
    expect(dl.headers['content-disposition']).toBe(`inline; filename="hoa don dien.pdf"; filename*=UTF-8''h%C3%B3a%20%C4%91%C6%A1n%20%C4%91i%E1%BB%87n.pdf`);
    expect(decodeURIComponent(dl.headers['content-disposition'].split("UTF-8''")[1])).toBe(vn);
    // validation
    await as('ketoan').post('/finance/entries', { date: T, title: 'X', amount: -5, categoryId: cat['Tiền ăn'] }).expect(400);
    expect((await as('ketoan').post('/finance/entries', { date: '2999-01-01', title: 'Tương lai', amount: 100000, categoryId: cat['Tiền ăn'] }).expect(400)).body.code).toBe('DATE_IN_FUTURE');
    expect((await as('ketoan').post('/finance/entries', { kind: 'in', date: T, title: 'Sai nhóm', amount: 100000, categoryId: cat['Tiền ăn'] }).expect(400)).body.code).toBe('INVALID_CATEGORY');
    await as('ketoan').get(`/finance/entries/${e.id}/receipt`).expect(200);
  });

  it('B29 helpers: latin1→UTF-8 decode is idempotent; ASCII fallback never breaks the header', () => {
    const vn = 'Hoá đơn tháng 9 – Đức.pdf';
    expect(decodeOriginalName(Buffer.from(vn, 'utf8').toString('latin1'))).toBe(vn); // what multer hands over
    expect(decodeOriginalName(vn)).toBe(vn); // already UTF-8 → unchanged
    expect(decodeOriginalName('plain.pdf')).toBe('plain.pdf');
    expect(decodeOriginalName('caf\u00e9.pdf')).toBe('caf\u00e9.pdf'); // real latin1 (invalid UTF-8) → unchanged
    expect(decodeOriginalName(undefined)).toBe('');
    expect(asciiFileName(vn)).toBe('Hoa don thang 9 _ Duc.pdf');
    expect(asciiFileName('"a";b\\c.pdf')).toBe('_a__b_c.pdf');
    expect(asciiFileName('漢字')).toBe('__');
    expect(contentDisposition('attachment', "it's (1).pdf")).toBe(`attachment; filename="it_s _1_.pdf"; filename*=UTF-8''it%27s%20%281%29.pdf`);
  });

  it('expenses > 10M by the accountant wait for admin approval; excluded from totals until approved', async () => {
    const before = (await as('admin').get(`/finance/summary?month=${M}`).expect(200)).body;
    const big = (await as('ketoan').post('/finance/entries', { date: T, title: 'Sửa máy lạnh lớp Lá 1 + Chồi 2', amount: 12500000, categoryId: cat['Sửa chữa, bảo trì'] }).expect(201)).body;
    expect(big).toMatchObject({ status: 'pending', pending: true, requiresApproval: true });
    expect((await ds.query(`SELECT n.type FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = 'admin' AND n.type = 'finance_approval'`)).length).toBe(1);
    // exactly 10M is NOT over the limit
    expect((await as('ketoan').post('/finance/entries', { date: T, title: 'Lương bảo vệ', amount: 10000000, categoryId: cat['Lương & BH'] }).expect(201)).body.status).toBe('approved');
    const mid = (await as('admin').get(`/finance/summary?month=${M}`).expect(200)).body;
    expect(mid.totalOut).toBe(before.totalOut + 10000000);
    expect(mid.pending).toEqual({ count: 1, amount: 12500000 });
    expect(mid.approvalLimit).toBe(10000000);
    const pend = (await as('admin').get(`/finance/transactions?month=${M}&status=pending`).expect(200)).body.items;
    expect(pend.map((x: any) => x.id)).toEqual([big.id]);
    await as('ketoan').post(`/finance/entries/${big.id}/approve`, {}).expect(403);
    expect((await as('admin').post(`/finance/entries/${big.id}/reject`, {}).expect(400)).body.code).toBe('NOTE_REQUIRED');
    expect((await as('admin').post(`/finance/entries/${big.id}/approve`, { note: 'OK' }).expect(200)).body).toMatchObject({ status: 'approved', decisionNote: 'OK', decidedBy: { name: expect.any(String) } });
    expect((await as('admin').post(`/finance/entries/${big.id}/approve`, {}).expect(409)).body.code).toBe('ALREADY_DECIDED');
    expect((await ds.query(`SELECT n.type FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.username = 'ketoan' AND n.type = 'finance_decision'`)).length).toBe(1);
    const after = (await as('admin').get(`/finance/summary?month=${M}`).expect(200)).body;
    expect(after.totalOut).toBe(mid.totalOut + 12500000);
    expect(after.pending.count).toBe(0);
    // reject flow
    const big2 = (await as('ketoan').post('/finance/entries', { date: T, title: 'Mua tivi', amount: 15000000, categoryId: cat['Đồ dùng học tập'] }).expect(201)).body;
    expect((await as('admin').post(`/finance/entries/${big2.id}/reject`, { note: 'Chưa cần' }).expect(200)).body.status).toBe('rejected');
    expect((await as('admin').get(`/finance/summary?month=${M}`).expect(200)).body.totalOut).toBe(after.totalOut);
    // admin's own big expense is approved directly
    expect((await as('admin').post('/finance/entries', { date: T, title: 'Lương tháng', amount: 98000000, categoryId: cat['Lương & BH'] }).expect(201)).body)
      .toMatchObject({ status: 'approved', requiresApproval: true });
    // void rules
    const small = (await as('ketoan').post('/finance/entries', { date: T, title: 'Nhập nhầm', amount: 200000, categoryId: cat['Chi khác'] }).expect(201)).body;
    await as('ketoan').post(`/finance/entries/${small.id}/void`, { note: 'nhầm' }).expect(403);
    expect((await as('admin').post(`/finance/entries/${small.id}/void`, {}).expect(400)).body.code).toBe('NOTE_REQUIRED');
    expect((await as('admin').post(`/finance/entries/${small.id}/void`, { note: 'Nhập nhầm' }).expect(200)).body.status).toBe('void');
    const big3 = (await as('ketoan').post('/finance/entries', { date: T, title: 'Máy giặt', amount: 11000000, categoryId: cat['Đồ dùng học tập'] }).expect(201)).body;
    expect((await as('ketoan').post(`/finance/entries/${big3.id}/void`, { note: 'Rút lại' }).expect(200)).body.status).toBe('void');
    const audit = await ds.query(`SELECT action FROM audit_events WHERE entity_type = 'finance_entry' AND entity_id = $1 ORDER BY created_at`, [big.id]);
    expect(audit.map((a: any) => a.action)).toEqual(['finance.expense.create', 'finance.entry.approve']);
  });

  it('summary: fee income is automatic from payments, other income, groups, previous month change', async () => {
    const s0 = (await as('ketoan').get(`/finance/summary?month=${M}`).expect(200)).body;
    expect(s0.in.fees).toBe(await feeSum(M));
    const [child] = await ds.query(`SELECT id FROM children LIMIT 1`);
    await ds.query(`INSERT INTO payments (receipt_no, child_id, amount, method, paid_at) VALUES ('PT-FIN-1', $1, 2450000, 'transfer', now()), ('PT-FIN-2', $1, 1000000, 'cash', now())`, [child.id]);
    await as('ketoan').post('/finance/entries', { kind: 'in', date: T, title: 'Thu bán đồng phục', amount: 3000000, categoryId: cat['Thu khác'] }).expect(201);
    await as('admin').post('/finance/entries', { date: `${PM}-15`, title: 'Lương tháng trước', amount: 90000000, categoryId: cat['Lương & BH'] }).expect(201);
    const s = (await as('admin').get(`/finance/summary?month=${M}`).expect(200)).body;
    expect(s.in).toMatchObject({ fees: s0.in.fees + 3450000, other: 3000000 });
    expect(s.totalIn).toBe(s.in.fees + s.in.other);
    expect(s.net).toBe(s.totalIn - s.totalOut);
    expect(s.totalOut).toBe(6200000 + 5100000 + 10000000 + 12500000 + 98000000);
    expect(s.outGroups[0]).toMatchObject({ name: 'Lương & BH', amount: 108000000 });
    expect(s.outGroups.map((g: any) => g.amount)).toEqual([...s.outGroups.map((g: any) => g.amount)].sort((a: number, b: number) => b - a));
    expect(s.prev).toMatchObject({ month: PM, totalOut: 90000000 });
    expect(s.change.totalOutPct).toBe(Math.round(((s.totalOut - 90000000) / 90000000) * 1000) / 10);
    const tx = (await as('ketoan').get(`/finance/transactions?month=${M}`).expect(200)).body.items;
    const fee = tx.filter((x: any) => x.source === 'fees' && x.date === T);
    expect(fee.length).toBeGreaterThanOrEqual(1);
    expect(fee[0]).toMatchObject({ auto: true, kind: 'in', status: 'approved', title: expect.stringMatching(/^Học phí · \d+ bé/) });
    expect(tx.some((x: any) => x.title === 'Máy giặt' && x.status === 'void')).toBe(true);
    expect(tx.find((x: any) => x.title === 'Mua rau, thịt tuần 2')).toMatchObject({ hasReceipt: true, receiptUrl: expect.stringContaining('/receipt') });
    const outs = (await as('ketoan').get(`/finance/transactions?month=${M}&kind=out`).expect(200)).body.items;
    expect(outs.every((x: any) => x.kind === 'out')).toBe(true);
    await as('ketoan').get('/finance/summary?month=2026-13').expect(400);
  });
});
