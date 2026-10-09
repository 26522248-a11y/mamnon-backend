process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'mamnon-test-uploads');

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { addDays, todayStr } from '../src/common/dates';
import { seed } from '../src/database/seed';
import * as ExcelJS from 'exceljs';
import { buildTemplate } from '../src/imports/children-import';

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
    expect(r.body.preview.find((p: any) => p.row === 10)).toMatchObject({ action: 'skip_duplicate', existingChildId: k0.id });
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
    const acc = wb.getWorksheet('Tài khoản phụ huynh')!;
    const rowsAcc: any[] = []; acc.eachRow((row, i) => { if (i > 1 && row.getCell(1).value) rowsAcc.push(row.values); });
    const ha = rowsAcc.find((v) => v[1] === '0977111222');
    expect(ha[3]).toMatch(/^[A-Za-z2-9]{10}$/);
    expect(ha[5]).toContain('Phạm Minh Châu');
    expect(rowsAcc.find((v) => v[1] === '0912000001')[4]).toBe('Đã có');
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
    expect(again.body.skippedDuplicates).toHaveLength(4);
    expect(await count('users')).toBe(users);
  });
  const login_ = (u: string) => login(u);
});
