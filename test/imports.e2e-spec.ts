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
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';
import * as ExcelJS from 'exceljs';
import { buildTemplate } from '../src/imports/children-import';
import * as fs from 'fs';
import * as path from 'path';

const nextMonth = (p: string) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

describe('Excel import: children + guardians (e2e)', () => {
  let app: NestExpressApplication, http: any, ds: DataSource;
  let s: Awaited<ReturnType<typeof seed>>;
  const tokens: Record<string, string> = {};
  const login = (username: string, password = '123456') => request(http).post('/api/v1/auth/login').send({ username, password });
  const as = (who: string) => {
    const t = () => ({ Authorization: `Bearer ${tokens[who]}` });
    return {
      get: (url: string) => request(http).get('/api/v1' + url).set(t()),
      post: (url: string, body?: any) => request(http).post('/api/v1' + url).set(t()).send(body),
      put: (url: string, body?: any) => request(http).put('/api/v1' + url).set(t()).send(body),
      patch: (url: string, body?: any) => request(http).patch('/api/v1' + url).set(t()).send(body),
      del: (url: string) => request(http).delete('/api/v1' + url).set(t()),
    };
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication<NestExpressApplication>());
    await app.init();
    http = app.getHttpServer();
    ds = app.get(DataSource);
    await ds.runMigrations();
    s = await seed(ds);
    for (const u of ['admin', 'gv1', 'ph1']) tokens[u] = (await login(u)).body.accessToken;
  });
  afterAll(async () => { await app?.close(); });


  const H = ['fullName', 'dob', 'gender', 'className', 'allergies', 'healthNotes', 'address', 'enrolledAt', 'g1Name', 'g1Relation', 'g1Phone', 'g1CanPickup', 'g2Name', 'g2Relation', 'g2Phone', 'g2CanPickup'];
  const xlsx = async (rows: Record<string, any>[]) => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildTemplate()) as any);
    const ws = wb.getWorksheet('Học sinh')!;
    rows.forEach((r, i) => H.forEach((k, j) => { if (r[k] !== undefined) ws.getCell(i + 2, j + 1).value = r[k]; }));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const up = (buf: Buffer, qs = '', who = 'admin', name = 'hs.xlsx') =>
    request(http).post(`/api/v1/imports/children${qs}`).set({ Authorization: `Bearer ${tokens[who]}` }).attach('file', buf, name);
  const count = async (t: string) => Number((await ds.query(`SELECT COUNT(*)::int AS n FROM ${t}`))[0].n);
  const base = (o: Record<string, any> = {}) => ({ fullName: 'Lê Thảo Vy', dob: '05/03/2022', gender: 'Nữ', className: 'Mầm 1', g1Name: 'Lê Văn Tâm', g1Relation: 'Bố', g1Phone: '0977000001', ...o });
  const readResult = async (b64: string) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(b64, 'base64') as any); return wb; };

  it('template download (admin only) is a real xlsx with the expected headers', async () => {
    const r = await request(http).get('/api/v1/imports/children/template').set({ Authorization: `Bearer ${tokens.admin}` }).buffer(true)
      .parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); }).expect(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    expect((wb.getWorksheet('Học sinh')!.getRow(1).values as any[]).slice(1, 5)).toEqual(['Họ tên bé *', 'Ngày sinh *', 'Giới tính *', 'Lớp *']);
    await as('gv1').get('/imports/children/template').expect(403);
  });

  it('auth + file checks: 403 non-admin, 400 no file / not xlsx / wrong template / empty, 400 > 1000 rows', async () => {
    const ok = await xlsx([base()]);
    await up(ok, '?dryRun=true', 'gv1').expect(403);
    await up(ok, '?dryRun=true', 'ph1').expect(403);
    expect((await request(http).post('/api/v1/imports/children?dryRun=true').set({ Authorization: `Bearer ${tokens.admin}` }).expect(400)).body.code).toBe('INVALID_FILE');
    expect((await up(Buffer.from('họ tên,ngày sinh\nA,1/1/2022'), '?dryRun=true', 'admin', 'fake.xlsx').expect(400)).body.code).toBe('INVALID_FILE');
    expect((await up(Buffer.from('PK\x03\x04garbage-not-a-zip'), '?dryRun=true', 'admin', 'x.xlsx').expect(400)).body.code).toBe('INVALID_FILE');
    const other = new ExcelJS.Workbook(); other.addWorksheet('S').addRow(['Tên', 'Tuổi']); other.getWorksheet('S')!.addRow(['A', 3]);
    const mm = await up(Buffer.from(await other.xlsx.writeBuffer()), '?dryRun=true').expect(400);
    expect(mm.body).toMatchObject({ code: 'TEMPLATE_MISMATCH', details: { missingColumns: expect.arrayContaining(['Họ tên bé *', 'PH1 - SĐT *']) } });
    expect((await up(await xlsx([]), '?dryRun=true').expect(400)).body.code).toBe('EMPTY_FILE');
    const many = await xlsx(Array.from({ length: 1001 }, (_, i) => base({ fullName: `Bé ${i}`, g1Phone: `0977${String(i).padStart(6, '0')}` })));
    expect((await up(many, '?dryRun=true').expect(400)).body.code).toBe('TOO_MANY_ROWS');
  });

  it('dryRun: per-row errors + preview, writes nothing; commit with errors -> 422, writes nothing', async () => {
    const before = { c: await count('children'), u: await count('users'), g: await count('guardians'), cl: await count('classes') };
    const k0 = s.kids[0];
    const buf = await xlsx([
      base(),                                                                   // 2 ok
      base({ fullName: 'Bé Sai Ngày', dob: '31/02/2022', g1Phone: '0977000002' }), // 3 bad date
      base({ fullName: 'Bé Sai Giới', gender: 'X', g1Phone: '0977000003' }),      // 4 bad gender
      base({ fullName: 'Bé Sai SĐT', g1Phone: '12345' }),                        // 5 bad phone
      base({ fullName: 'Bé Thiếu PH', g1Name: '', g1Phone: '' }),                 // 6 missing PH1
      base({ fullName: 'Bé Lớp Lạ', className: 'Lớp Không Có', g1Phone: '0977000006' }), // 7 unknown class
      base(),                                                                   // 8 duplicate of row 2
      base({ fullName: 'Bé SĐT GV', g1Phone: '0901000001' }),                    // 9 phone of teacher gv1 -> warning only
      base({ fullName: k0.fullName, dob: k0.dob.split('-').reverse().join('/'), gender: 'Nam', g1Phone: '0977000009' }), // 10 existing child -> skip
      base({ fullName: 'Bé Tương Lai', dob: '01/01/2099', g1Phone: '0977000010' }),       // 11 future dob
      base({ fullName: 'Bé PH2', g2Name: 'Mẹ', g2Phone: '0977000001', g1CanPickup: 'Có lẽ' }), // 12 PH2 same phone + bad yes/no
    ]);
    const r = await up(buf, '?dryRun=true').expect(200);
    expect(r.body).toMatchObject({ dryRun: true, ok: false, totalRows: 11, createClasses: false });
    const at = (row: number) => r.body.errors.filter((e: any) => e.row === row);
    expect(at(2)).toEqual([]);
    expect(at(3)[0]).toMatchObject({ field: 'dob', column: 'Ngày sinh *' });
    expect(at(4)[0]).toMatchObject({ field: 'gender' });
    expect(at(5)[0]).toMatchObject({ field: 'g1Phone', value: '12345' });
    expect(at(6).map((e: any) => e.field).sort()).toEqual(['g1Name', 'g1Phone']);
    expect(at(7)[0]).toMatchObject({ field: 'className', message: expect.stringContaining('createClasses') });
    expect(at(8)[0].message).toContain('dòng 2');
    expect(at(9)).toEqual([]); // teacher's phone (username differs): allowed, warned
    expect(r.body.warnings.find((w: any) => w.row === 9).message).toContain('nhân viên');
    expect(at(10)).toEqual([]);
    expect(at(11)[0].message).toContain('tương lai');
    expect(at(12).map((e: any) => e.field).sort()).toEqual(['g1CanPickup', 'g2Phone']);
    expect(r.body.preview.find((p: any) => p.row === 10)).toMatchObject({ action: 'skip_duplicate', existingChildId: k0.id, guardians: [{ phone: '0977000009', account: 'skip' }] });
    expect(r.body.preview.find((p: any) => p.row === 2)).toMatchObject({ action: 'create', child: { gender: 'F', dob: '2022-03-05', className: 'Mầm 1', classAction: 'existing' },
      guardians: [{ phone: '0977000001', username: '0977000001', account: 'create', canPickup: true, relation: 'Bố' }] });
    expect(r.body.summary).toMatchObject({ childrenToCreate: 2, duplicatesToSkip: 1, parentAccountsToCreate: 2 });
    expect(r.body.warnings.some((w: any) => w.row === 10)).toBe(true);
    await ds.query(`UPDATE users SET username = '0966000001' WHERE username = 'ketoan'`);
    const st = await up(await xlsx([base({ g1Phone: '0966000001' })]), '?dryRun=true').expect(200);
    expect(st.body.errors[0]).toMatchObject({ row: 2, field: 'g1Phone', message: expect.stringContaining('accountant') });
    await ds.query(`UPDATE users SET username = 'ketoan' WHERE username = '0966000001'`);
    const c = await up(buf).expect(422);
    expect(c.body).toMatchObject({ code: 'IMPORT_INVALID', details: { ok: false, errors: expect.any(Array) } });
    expect({ c: await count('children'), u: await count('users'), g: await count('guardians'), cl: await count('classes') }).toEqual(before);
  });

  it('import: one transaction, classes auto-created on request, accounts by phone (temp password in result xlsx), dedupe on re-import', async () => {
    const k0 = s.kids[0];
    const rows = [
      base({ fullName: 'Phạm Minh Khang', dob: new Date(Date.UTC(2021, 10, 2)), gender: 'Nam', className: 'mầm 1', allergies: 'Tôm', g1Name: 'Phạm Thu Hà', g1Relation: 'Mẹ', g1Phone: 977111222,
        g2Name: 'Phạm Văn Long', g2Relation: 'Bố', g2Phone: '+84 977 111 333', g2CanPickup: 'Không' }),
      base({ fullName: 'Phạm Minh Châu', dob: '2023-01-15', gender: 'Nữ', className: 'Nhà trẻ 2', g1Name: 'Phạm Thu Hà', g1Relation: 'Mẹ', g1Phone: '0977 111 222' }),
      base({ fullName: 'Bé Em Của An', dob: '10/10/2023', gender: 'Nam', className: 'Mầm 1', g1Name: 'Phụ huynh bé An', g1Phone: '0912000001' }), // ph1 existing
      base({ fullName: k0.fullName, dob: k0.dob.split('-').reverse().join('/'), gender: 'Nam', g1Phone: '0977000099' }), // existing child -> skipped
    ];
    const buf = await xlsx(rows);
    expect((await up(buf, '?dryRun=true').expect(200)).body.errors[0]).toMatchObject({ row: 3, field: 'className' }); // default: no auto-create
    const dry = await up(buf, '?dryRun=true&createClasses=true').expect(200);
    expect(dry.body).toMatchObject({ ok: true, summary: { childrenToCreate: 3, duplicatesToSkip: 1, classesToCreate: ['Nhà trẻ 2'], parentAccountsToCreate: 2, parentAccountsToLink: 1, guardiansToCreate: 4 } });
    const before = await count('children');
    const r = await up(buf, '?createClasses=true').expect(200);
    expect(r.body).toMatchObject({ ok: true, dryRun: false, imported: { children: 3, guardians: 4, parentAccountsCreated: 2, parentAccountsLinked: 1, classesCreated: ['Nhà trẻ 2'] } });
    expect(r.body.skippedDuplicates).toEqual([expect.objectContaining({ row: 5, existingChildId: k0.id })]);
    expect(JSON.stringify(r.body)).not.toMatch(/password/i); // temp passwords only inside the xlsx
    expect(await count('children')).toBe(before + 3);
    const [khang] = await ds.query(`SELECT c.*, cl.name AS class_name FROM children c JOIN classes cl ON cl.id = c.class_id WHERE full_name = 'Phạm Minh Khang'`);
    expect(khang).toMatchObject({ class_name: 'Mầm 1', gender: 'M', allergies: 'Tôm' });
    const [chau] = await ds.query(`SELECT cl.name, cl.age_group FROM children c JOIN classes cl ON cl.id = c.class_id WHERE full_name = 'Phạm Minh Châu'`);
    expect(chau).toEqual({ name: 'Nhà trẻ 2', age_group: '24-36 tháng' });
    const gs = await ds.query(`SELECT g.full_name, g.phone, g.can_pickup, u.username, u.must_change_password FROM guardians g JOIN users u ON u.id = g.user_id WHERE g.child_id = $1 ORDER BY g.full_name`, [khang.id]);
    expect(gs).toEqual([
      { full_name: 'Phạm Thu Hà', phone: '0977111222', can_pickup: true, username: '0977111222', must_change_password: true },
      { full_name: 'Phạm Văn Long', phone: '0977111333', can_pickup: false, username: '0977111333', must_change_password: true },
    ]);
    // one account for the mother of both children
    expect(Number((await ds.query(`SELECT COUNT(DISTINCT g.child_id)::int AS n FROM guardians g JOIN users u ON u.id = g.user_id WHERE u.username = '0977111222'`))[0].n)).toBe(2);
    // result xlsx carries the temp passwords; they work once and force a change
    const wb = await readResult(r.body.resultFile.base64);
    expect(r.body.resultFile).toMatchObject({ mimeType: expect.stringContaining('spreadsheetml'), fileName: expect.stringMatching(/\.xlsx$/) });
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Mật khẩu tạm (in phát)', 'Tài khoản đã có', 'Kết quả từng dòng', 'Lưu ý']);
    const sheetRows = (name: string) => { const out: any[][] = []; wb.getWorksheet(name)!.eachRow({ includeEmpty: true }, (row) => out.push((row.values as any[]).slice(1))); return out; };
    // print sheet: header + exactly one row per NEW account, every row has a password, no blank / note rows
    const pw = sheetRows('Mật khẩu tạm (in phát)');
    expect(pw[0]).toEqual(['STT', 'Tên đăng nhập (SĐT)', 'Họ tên phụ huynh', 'Mật khẩu tạm', 'Con (lớp)']);
    expect(pw).toHaveLength(1 + r.body.imported.parentAccountsCreated);
    expect(pw.slice(1).map((v) => v[1]).sort()).toEqual(['0977111222', '0977111333']);
    for (const v of pw.slice(1)) { expect(v[0]).toEqual(expect.any(Number)); expect(v[3]).toMatch(/^[A-Za-z2-9]{10}$/); expect(v[4]).toBeTruthy(); }
    const ha = pw.find((v) => v[1] === '0977111222')!;
    expect(ha[4]).toBe('Phạm Minh Khang (Mầm 1), Phạm Minh Châu (Nhà trẻ 2)');
    // linked existing account: separate sheet, labelled, no password anywhere
    expect(sheetRows('Tài khoản đã có')).toEqual([
      ['Tên đăng nhập (SĐT)', 'Họ tên', 'Mật khẩu', 'Con mới gắn (lớp)'],
      ['0912000001', expect.any(String), 'Tài khoản đã có – dùng mật khẩu cũ', 'Bé Em Của An (Mầm 1)'],
    ]);
    expect(pw.some((v) => v[1] === '0912000001')).toBe(false);
    expect(sheetRows('Lưu ý')[0][0]).toContain('Mật khẩu tạm chỉ có trong file này');
    // real import returns the same summary keys as dryRun + what was written
    expect(Object.keys(r.body.summary)).toEqual(expect.arrayContaining(Object.keys(dry.body.summary)));
    expect(r.body.summary).toMatchObject({ ...dry.body.summary, childrenCreated: 3, guardiansCreated: 4, parentAccountsCreated: 2, parentAccountsLinked: 1,
      classesCreated: ['Nhà trẻ 2'], duplicatesSkipped: 1 });
    const login = await request(http).post('/api/v1/auth/login').send({ username: '0977111222', password: ha[3] }).expect(200);
    expect(login.body.user).toMatchObject({ role: 'parent', mustChangePassword: true });
    const kids = (await request(http).get('/api/v1/children?limit=50').set({ Authorization: `Bearer ${login.body.accessToken}` }).expect(200)).body.items.map((x: any) => x.fullName).sort();
    expect(kids).toEqual(['Phạm Minh Châu', 'Phạm Minh Khang']);
    // existing parent ph1 now also sees the new child; password untouched
    const ph1 = (await login_('ph1')).body;
    expect((await request(http).get('/api/v1/children?limit=50').set({ Authorization: `Bearer ${ph1.accessToken}` }).expect(200)).body.items.map((x: any) => x.fullName)).toContain('Bé Em Của An');
    expect(ph1.user.mustChangePassword).toBe(false);
    const res = wb.getWorksheet('Kết quả từng dòng')!;
    expect(res.getRow(5).getCell(4).value).toContain('Bỏ qua');
    // re-import the same file: everything is a duplicate, nothing new
    const users = await count('users');
    const again = await up(buf, '?createClasses=true').expect(200);
    expect(again.body.imported).toMatchObject({ children: 0, guardians: 0, parentAccountsCreated: 0, classesCreated: [] });
    expect(again.body.summary).toMatchObject({ childrenToCreate: 0, duplicatesToSkip: 4, childrenCreated: 0, parentAccountsCreated: 0, duplicatesSkipped: 4 });
    const wb2 = await readResult(again.body.resultFile.base64);
    expect(wb2.getWorksheet('Mật khẩu tạm (in phát)')!.actualRowCount).toBe(1); // header only: nothing to print
    expect(again.body.skippedDuplicates).toHaveLength(4);
    expect(await count('users')).toBe(users);
  });

  // ---- hotfix/import: files from other tools, all errors per row, skip account, 413 ----
  const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures/import', f));
  const OK_FILES = [
    'ok_openpyxl.xlsx', 'ok_libreoffice.xlsx',                         // tester's files (openpyxl used to fail: absolute rels targets)
    'ok_gsheets_like.xlsx', 'ok_excel_like.xlsx', 'ok_inlinestr_text.xlsx', // hand-built package shapes (make_fixtures.py)
    'exceljs_sst_serial.xlsx', 'exceljs_inline_text.xlsx', 'sheetjs_sst_serial.xlsx', 'sheetjs_inline_text.xlsx', // make_writer_fixtures.js
  ];
  it.each(OK_FILES)('reads %s (dryRun: 2 children, 3 parent accounts, same data whatever the writer)', async (f) => {
    const r = await up(fx(f), '?dryRun=true', 'admin', f).expect(200);
    expect(r.body).toMatchObject({ ok: true, totalRows: 2, sheet: 'Học sinh', errors: [],
      summary: { childrenToCreate: 2, parentAccountsToCreate: 3, guardiansToCreate: 3, errorCount: 0 } });
    expect(r.body.preview.map((p: any) => [p.row, p.child.fullName, p.child.dob, p.child.gender, p.child.className, p.guardians.map((g: any) => `${g.phone}:${g.canPickup}`)])).toEqual([
      [2, 'QA Nhập Một', '2022-03-01', 'M', 'Mầm 1', ['0987000001:true']],
      [3, 'QA Nhập Hai', '2022-04-02', 'F', 'Mầm 1', ['0987000002:true', '0987000003:false']],
    ]);
    expect(r.body.preview[1].child.allergies).toBe('Sữa');
  });

  it.each(['bad_multi_errors.xlsx', 'bad_multi_libreoffice.xlsx'])('%s: every error of a row is reported at once (incl. unknown class)', async (f) => {
    const r = await up(fx(f), '?dryRun=true&createClasses=false', 'admin', f).expect(200);
    expect(r.body).toMatchObject({ ok: false, totalRows: 2, preview: [] });
    const fields = (row: number) => r.body.errors.filter((e: any) => e.row === row).map((e: any) => e.field).sort();
    expect(fields(2)).toEqual(['className', 'dob', 'fullName', 'g1Name', 'g1Phone', 'gender']);
    expect(fields(3)).toEqual(['className', 'dob', 'g2Phone']);
    expect(r.body.errors.find((e: any) => e.row === 3 && e.field === 'className')).toMatchObject({ value: 'Lá 9', column: 'Lớp *' });
    expect(r.body.summary).toMatchObject({ errorRows: 2, errorCount: 9, classesToCreate: [] });
  });

  it('class / in-file duplicate / staff-phone checks run even when the row already has field errors', async () => {
    await ds.query(`UPDATE users SET username = '0966000002' WHERE username = 'ketoan'`);
    try {
      const r = await up(await xlsx([
        base({ fullName: 'Bé Hai Lỗi', className: 'Lá 9', g1Phone: '0977000101', g2Name: 'Mẹ', g2Phone: '0977000101' }), // 2: PH2 = PH1 + unknown class
        base({ fullName: 'Bé Hai Lỗi', gender: 'X', className: 'Lá 9', g1Phone: '0966000002' }),                        // 3: gender + dup row 2 + class + staff phone
      ]), '?dryRun=true').expect(200);
      const fields = (row: number) => r.body.errors.filter((e: any) => e.row === row).map((e: any) => e.field).sort();
      expect(fields(2)).toEqual(['className', 'g2Phone']);
      expect(fields(3)).toEqual(['className', 'fullName', 'g1Phone', 'gender']);
      expect(r.body.preview).toEqual([]);
    } finally { await ds.query(`UPDATE users SET username = 'ketoan' WHERE username = '0966000002'`); }
  });

  it('a file > 5MB is rejected with 413', async () => {
    const big = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    const r = await up(big, '?dryRun=true').expect(413);
    expect(r.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('result file: 3 new + 2 linked accounts (one locked) -> print sheet has exactly 3 rows, all with passwords', async () => {
    await ds.query(`UPDATE users SET is_active = false WHERE username = '0977111333'`);
    try {
      const buf = await xlsx([
        base({ fullName: 'QA KQ Một', dob: '01/02/2022', g1Name: 'QA KQ Bố Một', g1Phone: '0988000001' }),
        base({ fullName: 'QA KQ Hai', dob: '02/02/2022', g1Name: 'QA KQ Mẹ Hai', g1Phone: '0988000002', g2Name: 'QA KQ Bà Hai', g2Relation: 'Bà', g2Phone: '0988000003' }),
        base({ fullName: 'QA KQ Ba', dob: '03/02/2022', g1Name: 'QA KQ Bố Một', g1Phone: '0988000001', g2Name: 'Phạm Thu Hà', g2Relation: 'Mẹ', g2Phone: '0977111222' }), // new (2nd child) + existing
        base({ fullName: 'QA KQ Bốn', dob: '04/02/2022', g1Name: 'Phạm Văn Long', g1Phone: '0977111333' }),                                                          // existing, locked
      ]);
      const r = await up(buf).expect(200);
      expect(r.body.summary).toMatchObject({ childrenToCreate: 4, childrenCreated: 4, parentAccountsToCreate: 3, parentAccountsCreated: 3, parentAccountsToLink: 2, parentAccountsLinked: 2, guardiansCreated: 6 });
      const wb = await readResult(r.body.resultFile.base64);
      const rows = (n: string) => { const out: any[][] = []; wb.getWorksheet(n)!.eachRow({ includeEmpty: true }, (row, i) => { if (i > 1) out.push((row.values as any[]).slice(1)); }); return out; };
      const pw = rows('Mật khẩu tạm (in phát)');
      expect(pw.map((v) => [v[0], v[1]])).toEqual([[1, '0988000001'], [2, '0988000002'], [3, '0988000003']]);
      expect(pw.every((v) => /^[A-Za-z2-9]{10}$/.test(v[3]))).toBe(true);
      expect(pw[0][4]).toBe('QA KQ Một (Mầm 1), QA KQ Ba (Mầm 1)'); // one row per parent, all children listed
      const ex = rows('Tài khoản đã có');
      expect(ex.map((v) => [v[0], v[2]])).toEqual([
        ['0977111222', 'Tài khoản đã có – dùng mật khẩu cũ'],
        ['0977111333', expect.stringMatching(/^Tài khoản đã có – dùng mật khẩu cũ \(đang bị khoá/)],
      ]);
      expect(ex.flat().some((x) => typeof x === 'string' && /^[A-Za-z2-9]{10}$/.test(x) && !x.startsWith('0'))).toBe(false);
    } finally { await ds.query(`UPDATE users SET is_active = true WHERE username = '0977111333'`); }
  });

  // ---- P0: phone of an existing parent account with a DIFFERENT name must never be linked silently ----
  describe('P0 phone/name mismatch (never link a child to another person\'s account)', () => {
    const upC = (buf: Buffer, qs: string, confirmLinks?: any, name = 'p0.xlsx') => {
      const req = request(http).post(`/api/v1/imports/children${qs}`).set({ Authorization: `Bearer ${tokens.admin}` });
      if (confirmLinks !== undefined) req.field('confirmLinks', typeof confirmLinks === 'string' ? confirmLinks : JSON.stringify(confirmLinks));
      return req.attach('file', buf, name);
    };
    let boMot: { id: string };
    beforeAll(async () => {
      await up(fx('ok_openpyxl.xlsx')).expect(200); // creates 'QA Bố Một' 0987000001 (+ child QA Nhập Một)
      [boMot] = await ds.query(`SELECT id FROM users WHERE username = '0987000001'`);
    });
    const kidsOf = async (uid: string) => (await ds.query(`SELECT c.full_name FROM guardians g JOIN children c ON c.id = g.child_id WHERE g.user_id = $1 ORDER BY 1`, [uid])).map((x: any) => x.full_name);

    it('p0_sdt_trung_khac_ten: different name -> PHONE_NAME_MISMATCH in dryRun, 422 on import, nothing written', async () => {
      const f = fx('p0_sdt_trung_khac_ten.xlsx');
      const d = await upC(f, '?dryRun=true').expect(200);
      expect(d.body.ok).toBe(false);
      expect(d.body.errors).toEqual([expect.objectContaining({ row: 2, field: 'g1Phone', code: 'PHONE_NAME_MISMATCH', value: '0987000001',
        message: expect.stringContaining('đang thuộc tài khoản phụ huynh "QA Bố Một", khác tên "QA Người Lạ"'),
        existingAccount: { userId: boMot.id, name: 'QA Bố Một', childrenCount: 1 } })]);
      const before = await count('guardians');
      expect((await upC(f, '').expect(422)).body.details.errors[0].code).toBe('PHONE_NAME_MISMATCH');
      expect(await count('guardians')).toBe(before);
      expect(await kidsOf(boMot.id)).toEqual(['QA Nhập Một']);
    });

    it('exact regression: PH2 "QA Bà Hai" with the phone of "QA Bố Một" is an error (was silently linked)', async () => {
      const r = await up(await xlsx([base({ fullName: 'QA Nhập Bốn', dob: '01/05/2022', g1Name: 'QA Mẹ Bốn', g1Phone: '0987000012', g2Name: 'QA Bà Hai', g2Relation: 'Bà', g2Phone: '0987000001' })]), '?dryRun=true').expect(200);
      expect(r.body.errors).toEqual([expect.objectContaining({ row: 2, field: 'g2Phone', code: 'PHONE_NAME_MISMATCH' })]);
      expect(r.body.preview).toEqual([]);
    });

    it('diacritics are significant ("QA Bo Mot" != "QA Bố Một"), and NFD input is normalised to NFC', async () => {
      const noAccent = await up(await xlsx([base({ fullName: 'QA Dấu', g1Name: 'QA Bo Mot', g1Phone: '0987000001' })]), '?dryRun=true').expect(200);
      expect(noAccent.body.errors[0]).toMatchObject({ code: 'PHONE_NAME_MISMATCH' });
      const nfd = await up(await xlsx([base({ fullName: 'QA NFD', g1Name: '  QA  Bố Một '.normalize('NFD'), g1Phone: '0987000001' })]), '?dryRun=true').expect(200);
      expect(nfd.body).toMatchObject({ ok: true, errors: [] });
    });

    it('confirmLinks overrides only the listed (row, guardian); dryRun shows ok + warning; import links', async () => {
      const f = fx('p0_sdt_trung_khac_ten.xlsx');
      expect((await upC(f, '?dryRun=true', [{ row: 2, guardian: 2 }]).expect(200)).body.ok).toBe(false); // other slot: still blocked
      expect((await upC(f, '?dryRun=true', [{ row: 3, guardian: 1 }]).expect(200)).body.ok).toBe(false); // other row: still blocked
      const d = await upC(f, '?dryRun=true', [{ row: 2, guardian: 1 }]).expect(200);
      expect(d.body).toMatchObject({ ok: true, errors: [] });
      expect(d.body.preview[0].guardians[0]).toMatchObject({ account: 'existing', accountName: 'QA Bố Một', linkConfirmed: true });
      expect(d.body.warnings.find((w: any) => w.row === 2).message).toMatch(/khác tên "QA Người Lạ", đã xác nhận gắn.*QA Nhập Một/);
      for (const bad of ['not json', '{"row":2}', '[{"row":2,"guardian":3}]', '[{"row":"2","guardian":1}]'])
        expect((await upC(f, '?dryRun=true', bad).expect(400)).body.code).toBe('VALIDATION_ERROR');
      await upC(f, '', [{ row: 2, guardian: 1 }]).expect(200);
      expect(await kidsOf(boMot.id)).toEqual(['QA Nhập Một', 'QA P0 Một']);
    });

    it('p0_sdt_trung_dung_ten + p0_ten_khac_dau_hoa: same name (case / spacing only) -> link, warning lists the existing children', async () => {
      for (const f of ['p0_sdt_trung_dung_ten.xlsx', 'p0_ten_khac_dau_hoa.xlsx']) {
        const d = await upC(fx(f), '?dryRun=true').expect(200);
        expect(d.body).toMatchObject({ ok: true, errors: [], summary: { parentAccountsToCreate: 0, parentAccountsToLink: 1 } });
        expect(d.body.preview[0].guardians[0]).toMatchObject({ account: 'existing', accountName: 'QA Bố Một' });
        expect(d.body.preview[0].guardians[0].linkConfirmed).toBeUndefined();
        expect(d.body.warnings.find((w: any) => w.row === 2).message).toContain('Tài khoản đang có bé: QA Nhập Một, QA P0 Một');
      }
      await upC(fx('p0_ten_khac_dau_hoa.xlsx'), '').expect(200);
      expect(await kidsOf(boMot.id)).toEqual(['QA Nhập Một', 'QA P0 Một', 'QA P0 Năm']);
    });

    it('p0_cung_file_2_ten: same new phone, two names in one file -> error on the 2nd row (conflictRow), override possible', async () => {
      const f = fx('p0_cung_file_2_ten.xlsx');
      const d = await upC(f, '?dryRun=true').expect(200);
      expect(d.body.ok).toBe(false);
      expect(d.body.errors).toEqual([expect.objectContaining({ row: 3, field: 'g1Phone', code: 'PHONE_NAME_MISMATCH', existingAccount: null, conflictRow: 2 })]);
      await upC(f, '').expect(422);
      expect(await count('users WHERE username = \'0987000021\'')).toBe(0);
      const ok = await upC(f, '?dryRun=true', [{ row: 3, guardian: 1 }]).expect(200);
      expect(ok.body).toMatchObject({ ok: true, summary: { parentAccountsToCreate: 1 } });
    });

    it('DELETE /children/:id/guardians/:guardianId: admin + reason, revokes the parent\'s access at once, audit-logged', async () => {
      const [g] = await ds.query(`SELECT g.id, g.child_id FROM guardians g JOIN children c ON c.id = g.child_id WHERE g.user_id = $1 AND c.full_name = 'QA P0 Một'`, [boMot.id]);
      const pw = 'Abc12345';
      await ds.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [boMot.id, require('bcryptjs').hashSync(pw, 4)]);
      const parent = (await request(http).post('/api/v1/auth/login').send({ username: '0987000001', password: pw }).expect(200)).body.accessToken;
      const asParent = (url: string) => request(http).get('/api/v1' + url).set({ Authorization: `Bearer ${parent}` });
      await asParent(`/children/${g.child_id}`).expect(200);
      const url = `/children/${g.child_id}/guardians/${g.id}`;
      await as('gv1').del(url).send({ reason: 'x' }).expect(403);
      await request(http).delete('/api/v1' + url).set({ Authorization: `Bearer ${parent}` }).send({ reason: 'x' }).expect(403);
      for (const body of [{}, { reason: '' }, { reason: '   ' }]) await request(http).delete('/api/v1' + url).set({ Authorization: `Bearer ${tokens.admin}` }).send(body).expect(400);
      await request(http).delete(`/api/v1/children/${s.kids[0].id}/guardians/${g.id}`).set({ Authorization: `Bearer ${tokens.admin}` }).send({ reason: 'x' }).expect(404); // guardian of another child
      const r = await request(http).delete('/api/v1' + url).set({ Authorization: `Bearer ${tokens.admin}` }).send({ reason: 'Gắn nhầm khi nhập Excel' }).expect(200);
      expect(r.body).toMatchObject({ removed: { guardianId: g.id, childId: g.child_id, childName: 'QA P0 Một', fullName: 'QA Người Lạ', phone: '0987000001' },
        account: { userId: boMot.id, username: '0987000001', name: 'QA Bố Một', remainingChildren: ['QA Nhập Một', 'QA P0 Năm'], accountHasNoChildren: false }, reason: 'Gắn nhầm khi nhập Excel' });
      await asParent(`/children/${g.child_id}`).expect(403); // same token, access gone immediately
      expect((await asParent('/children?limit=50').expect(200)).body.items.map((x: any) => x.fullName).sort()).toEqual(['QA Nhập Một', 'QA P0 Năm']);
      await request(http).delete('/api/v1' + url).set({ Authorization: `Bearer ${tokens.admin}` }).send({ reason: 'x' }).expect(404);
      const lines = fs.readFileSync(path.join(process.env.AUDIT_LOG_DIR!, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.at(-1)).toMatchObject({ action: 'guardian.remove', actorUsername: 'admin', reason: 'Gắn nhầm khi nhập Excel', removed: { guardianId: g.id }, account: { userId: boMot.id } });
      // last child removed -> account kept, reported
      const rest = await ds.query(`SELECT id, child_id FROM guardians WHERE user_id = $1`, [boMot.id]);
      let last: any;
      for (const x of rest) last = (await request(http).delete(`/api/v1/children/${x.child_id}/guardians/${x.id}`).set({ Authorization: `Bearer ${tokens.admin}` }).send({ reason: 'test' }).expect(200)).body;
      expect(last.account).toMatchObject({ remainingChildren: [], accountHasNoChildren: true });
      expect(await count(`users WHERE id = '${boMot.id}'`)).toBe(1);
    });
  });
  const login_ = (u: string) => login(u);
});
