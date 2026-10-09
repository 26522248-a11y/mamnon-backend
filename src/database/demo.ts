/**
 * Demo dataset for guide screenshots on staging – loadable and removable with one command each.
 *   npm run demo:load   (DATABASE_URL=… ; refuses if demo data is already loaded)
 *   npm run demo:purge  (deletes ONLY rows recorded as demo; real accounts/data stay)
 * Marking: before loading we snapshot every table's ids; after loading, each NEW row id is recorded in
 * demo_registry(table_name, row_id). Purge deletes exactly those rows (FK cascades take dependent rows such as
 * class_teachers / invoice lines / notifications of demo announcements), retrying in passes until FK order works out.
 * Existing classes named "Mầm 1"/"Chồi 1" are reused (not marked); their demo children/attendance are marked.
 * Network blocks 5432? Build a DataSource from data-source options with driver: { ...require('pg'), Pool: require('@neondatabase/serverless').Pool }
 * (neonConfig.webSocketConstructor = require('ws')) and call demoLoad/demoPurge – same code over WebSocket/443.
 * No photo uploads, no accounts with known passwords (demo teachers get a random, unprinted password).
 */
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { addDays, todayStr } from '../common/dates';
import {
  Announcement, Attendance, AttendanceHistory, Child, ClassRoom, ClassTeacher, DailyNote, FeeItem, FinanceCategory, FinanceEntry, Guardian,
  Invoice, MenuItem, Notification, Payment, StaffCheckin, StaffLeave, StaffShift, StaffShiftAssignment, StaffSubstitution, User,
} from './entities';

const REG = 'demo_registry';

async function idTables(m: EntityManager): Promise<string[]> {
  const rows = await m.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = current_schema() AND c.column_name = 'id' AND t.table_type = 'BASE TABLE' AND c.table_name NOT IN ('migrations', '${REG}')`);
  return rows.map((r: { table_name: string }) => r.table_name);
}

export async function demoLoaded(ds: DataSource): Promise<number> {
  const [{ t }] = await ds.query(`SELECT to_regclass('${REG}') IS NOT NULL AS t`);
  return t ? Number((await ds.query(`SELECT COUNT(*)::int AS n FROM ${REG}`))[0].n) : 0;
}

/** Runs fn inside one transaction and records every row it created in demo_registry. */
async function recordNew(ds: DataSource, fn: (m: EntityManager) => Promise<void>) {
  await ds.transaction(async (m) => {
    await m.query(`CREATE TABLE IF NOT EXISTS ${REG} (table_name text NOT NULL, row_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (table_name, row_id))`);
    const tables = await idTables(m);
    await m.query(`CREATE TEMP TABLE demo_before (table_name text, row_id text) ON COMMIT DROP`);
    for (const t of tables) await m.query(`INSERT INTO demo_before SELECT '${t}', id::text FROM "${t}"`);
    await fn(m);
    for (const t of tables) await m.query(`INSERT INTO ${REG} (table_name, row_id) SELECT '${t}', id::text FROM "${t}" x
      WHERE NOT EXISTS (SELECT 1 FROM demo_before b WHERE b.table_name = '${t}' AND b.row_id = x.id::text) ON CONFLICT DO NOTHING`);
  });
}

export async function demoPurge(ds: DataSource): Promise<{ deleted: Record<string, number>; left: number }> {
  if (!(await demoLoaded(ds))) return { deleted: {}, left: 0 };
  const deleted: Record<string, number> = {};
  // rows testers added later on top of demo children/shifts (not registered) would block via ON DELETE RESTRICT → remove them too
  const demoIds = (t: string) => `(SELECT row_id::uuid FROM ${REG} WHERE table_name = '${t}')`;
  await ds.transaction(async (m) => {
    // parent logins created later for demo children only (e.g. a demo parent for testers) → removed with them
    await m.query(`INSERT INTO ${REG} (table_name, row_id) SELECT 'users', u.id::text FROM users u WHERE u.role = 'parent'
      AND EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id AND g.child_id IN ${demoIds('children')})
      AND NOT EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id AND g.child_id NOT IN ${demoIds('children')}) ON CONFLICT DO NOTHING`);
    // sensitive-change history recorded on demo children (audit trail has no FK)
    for (const t of ['audit_events', 'child_contact_history']) await m.query(`DELETE FROM "${t}" WHERE child_id IN ${demoIds('children')}`).catch(() => undefined);
    for (const t of ['credit_transactions', 'refund_payouts', 'payments', 'invoices']) await m.query(`DELETE FROM "${t}" WHERE child_id IN ${demoIds('children')}`).catch(() => undefined);
    for (const t of ['staff_substitutions', 'staff_shift_assignments']) await m.query(`DELETE FROM "${t}" WHERE shift_id IN ${demoIds('staff_shifts')}`);
  });
  for (let pass = 0; pass < 12; pass++) {
    const tables: string[] = (await ds.query(`SELECT DISTINCT table_name FROM ${REG}`)).map((r: { table_name: string }) => r.table_name);
    if (!tables.length) break;
    let progress = false;
    for (const t of tables) {
      try {
        await ds.transaction(async (m) => {
          const r = await m.query(`DELETE FROM "${t}" WHERE id::text IN (SELECT row_id FROM ${REG} WHERE table_name = $1)`, [t]);
          deleted[t] = (deleted[t] ?? 0) + (r?.[1] ?? 0);
          await m.query(`DELETE FROM ${REG} WHERE table_name = $1`, [t]);
        });
        progress = true;
      } catch { /* FK order: retry next pass */ }
    }
    if (!progress) break;
  }
  const left = Number((await ds.query(`SELECT COUNT(*)::int AS n FROM ${REG}`))[0].n);
  if (!left) await ds.query(`DROP TABLE ${REG}`);
  return { deleted, left };
}

const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Võ', 'Đặng', 'Bùi', 'Đỗ'];
const DEM_M = ['Minh', 'Gia', 'Đức', 'Quang', 'Hoàng'], DEM_F = ['Ngọc', 'Bảo', 'Khánh', 'Thảo', 'Hà'];
const TEN_M = ['Khôi', 'Phúc', 'Huy', 'Nam', 'Long', 'Bảo', 'Tín', 'Kiên'], TEN_F = ['Anh', 'Vy', 'Linh', 'Chi', 'My', 'Trâm', 'Nhi', 'Hân'];
const BO = ['Hùng', 'Tuấn', 'Dũng', 'Sơn', 'Thắng', 'Phong'], ME = ['Hoa', 'Lan', 'Thu', 'Hương', 'Mai', 'Hạnh'];

export async function demoLoad(ds: DataSource) {
  if (await demoLoaded(ds)) throw new Error('Demo data already loaded – run npm run demo:purge first');
  const summary: Record<string, number> = {};
  await recordNew(ds, async (m) => {
    const today = todayStr(), y = addDays(today, -1), thisMonth = today.slice(0, 7);
    const [yy, mm] = thisMonth.split('-').map(Number);
    const lastMonth = mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, '0')}`;
    const admin = await m.findOne(User, { where: { role: 'admin', isActive: true }, order: { createdAt: 'ASC' } });
    if (!admin) throw new Error('No admin account – run bootstrap:admin first');
    const acct = (await m.findOne(User, { where: { role: 'accountant', isActive: true }, order: { createdAt: 'ASC' } })) ?? admin;
    const pw = await bcrypt.hash(randomBytes(24).toString('base64url'), 10);
    const t1 = await m.save(User, { username: 'demo_gv_huong', name: 'Cô Phạm Thu Hương', role: 'teacher', phone: '0908111222', passwordHash: pw, mustChangePassword: true } as any);
    const t2 = await m.save(User, { username: 'demo_gv_mai', name: 'Cô Lê Ngọc Mai', role: 'teacher', phone: '0908333444', passwordHash: pw, mustChangePassword: true } as any);
    const cls = async (name: string, ageGroup: string, room: string) =>
      (await m.findOne(ClassRoom, { where: { name } })) ?? (await m.save(ClassRoom, { name, ageGroup, schoolYear: '2026-2027', room, capacity: 25 }));
    const classes = [await cls('Mầm 1', '3-4 tuổi', 'P101'), await cls('Chồi 1', '4-5 tuổi', 'P102'), await cls('Lá 1', '5-6 tuổi', 'P201')];
    const existingT1 = await m.findOne(ClassTeacher, { where: { classId: classes[0].id } });
    await m.save(ClassTeacher, [{ classId: classes[1].id, userId: t1.id, isHead: true }, { classId: classes[2].id, userId: t2.id, isHead: true }]);
    const teachers = [existingT1?.userId ?? t1.id, t1.id, t2.id];

    const kids: Child[] = [];
    let n = 0;
    for (const [ci, c] of classes.entries()) {
      const count = 8 + ci; // 8, 9, 10 new children (+ existing ones)
      for (let i = 0; i < count; i++, n++) {
        const f = n % 2 === 1, ho = HO[(n * 3) % HO.length];
        const fullName = `${ho} ${(f ? DEM_F : DEM_M)[n % 5]} ${(f ? TEN_F : TEN_M)[(n * 5 + ci) % 8]}`;
        const k = await m.save(Child, { fullName, dob: `${2023 - ci}-${String((n % 12) + 1).padStart(2, '0')}-${String((n * 7) % 27 + 1).padStart(2, '0')}`,
          gender: f ? 'F' : 'M', classId: c.id, allergies: n % 9 === 4 ? 'Dị ứng tôm' : null, healthNotes: n % 13 === 6 ? 'Hen suyễn nhẹ, mang theo thuốc xịt' : null,
          address: `${12 + n} Ấp ${n % 3 ? '12A' : '5'}, Xã Trảng Bom, Đồng Nai`, enrolledAt: '2026-09-05', status: 'active' } as any);
        await m.save(Guardian, [
          { childId: k.id, fullName: `${ho} Văn ${BO[n % BO.length]}`, relation: 'Bố', phone: `09${String(12000000 + n * 7919).slice(0, 8)}`, canPickup: true },
          { childId: k.id, fullName: `${HO[(n * 7 + 1) % HO.length]} Thị ${ME[n % ME.length]}`, relation: 'Mẹ', phone: `08${String(34000000 + n * 6271).slice(0, 8)}`, canPickup: true },
        ] as any);
        kids.push(k);
      }
    }
    const all = await m.find(Child, { where: classes.map((c) => ({ classId: c.id, status: 'active' as const })) });
    summary.children = kids.length;

    // ── attendance + daily notes: Monday of this week .. today (weekdays)
    const dow = new Date(today + 'T00:00:00Z').getUTCDay(), monday = addDays(today, dow === 0 ? -6 : 1 - dow);
    const days: string[] = [];
    for (let d = monday; d <= today; d = addDays(d, 1)) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w >= 1 && w <= 5) days.push(d); }
    let att = 0;
    for (const [di, d] of days.entries()) for (const [i, k] of all.entries()) {
      if (await m.findOne(Attendance, { where: { childId: k.id, date: d } })) continue;
      const ci = classes.findIndex((c) => c.id === k.classId);
      const status = (i + di) % 11 === 0 ? 'absent' : (i + di) % 7 === 3 ? 'late' : 'present';
      const a = await m.save(Attendance, { childId: k.id, classId: k.classId!, date: d, status, note: status === 'absent' ? 'Phụ huynh xin nghỉ: bé bị sốt' : null,
        notifiedInAdvance: status === 'absent', recordedBy: teachers[ci] } as any);
      await m.save(AttendanceHistory, { attendanceId: a.id, action: 'create', oldStatus: null, oldNote: null, oldNotified: null, newStatus: a.status, newNote: a.note, newNotified: a.notifiedInAdvance, changedBy: teachers[ci] } as any);
      att++;
      if (status !== 'absent' && d < today && !(await m.findOne(DailyNote, { where: { childId: k.id, date: d } })))
        await m.save(DailyNote, { childId: k.id, classId: k.classId!, date: d, eating: (['all', 'most', 'all', 'half', 'all'] as const)[(i + di) % 5],
          sleepMinutes: 90 + ((i + di) % 4) * 15, mood: (i + di) % 6 === 0 ? 'Hơi mệt' : 'Vui vẻ', toilet: 'Bình thường',
          note: (i + di) % 8 === 0 ? 'Bé tham gia tích cực giờ vẽ tranh' : null, recordedBy: teachers[ci] } as any);
    }
    summary.attendance = att;

    // ── fees + invoices (last month mostly paid, this month mixed)
    const fee = async (name: string, amount: number, extra: object = {}) =>
      (await m.findOne(FeeItem, { where: { name } })) ?? (await m.save(FeeItem, { name, amount, type: 'monthly', scope: 'school', ...extra } as any));
    const tuition = await fee('Học phí', 1_800_000), meals = await fee('Tiền ăn', 950_000, { mealRefundPerDay: 40_000 });
    const english = await m.save(FeeItem, { name: 'Tiếng Anh (Lá 1)', amount: 300_000, type: 'monthly', scope: 'class', classId: classes[2].id } as any);
    const nextNo = async (seq: string, p: string, period: string) => `${p}${period.replace('-', '')}-${String((await m.query(`SELECT nextval('${seq}') AS n`))[0].n).padStart(5, '0')}`;
    let inv = 0;
    for (const period of [lastMonth, thisMonth]) for (const [i, k] of kids.entries()) {
      const fees = [tuition, meals, ...(k.classId === classes[2].id ? [english] : [])];
      const total = fees.reduce((s, f) => s + Number(f.amount), 0);
      const paid = period === lastMonth ? (i % 9 === 8 ? 0 : i % 7 === 6 ? 1_000_000 : total) : (i % 3 === 0 ? total : i % 4 === 1 ? 1_500_000 : 0);
      const invoice = await m.save(Invoice, m.create(Invoice, { invoiceNo: await nextNo('invoice_no_seq', 'HD', period), childId: k.id, classId: k.classId, period,
        issueDate: `${period}-01`, dueDate: `${period}-10`, totalAmount: total, paidAmount: paid, status: paid === 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial', createdBy: acct.id,
        lines: fees.map((f) => ({ feeItemId: f.id, kind: 'charge', description: f.name, quantity: 1, unitPrice: Number(f.amount), amount: Number(f.amount) })) } as any));
      inv++;
      if (paid > 0) await m.save(Payment, { receiptNo: await nextNo('receipt_no_seq', 'PT', period), invoiceId: invoice.id, childId: k.id, amount: paid,
        method: i % 2 ? 'cash' : 'transfer', paidAt: new Date(`${period}-0${(i % 8) + 2}T09:00:00+07:00`), receivedBy: acct.id, payerName: null } as any);
    }
    summary.invoices = inv;

    // ── staff: shift, assignments this week, check-ins, one leave, one substitution
    const shift = await m.save(StaffShift, { name: 'Ca sáng', startTime: '07:00', endTime: '16:30', lateGraceMinutes: 10 } as any);
    const tomorrow = addDays(today, 1);
    for (const d of [...days, tomorrow]) for (const [ci, uid] of teachers.entries())
      await m.save(StaffShiftAssignment, { date: d, userId: uid, shiftId: shift.id, classId: classes[ci].id, createdBy: admin.id } as any);
    for (const d of days) for (const [ci, uid] of teachers.entries()) {
      if (await m.findOne(StaffCheckin, { where: { userId: uid, date: d } })) continue;
      const late = (ci + days.indexOf(d)) % 5 === 4;
      await m.save(StaffCheckin, { date: d, userId: uid, checkInAt: new Date(`${d}T${late ? '07:18' : '06:5' + ci}:00+07:00`),
        checkOutAt: d < today ? new Date(`${d}T16:4${ci}:00+07:00`) : null, source: 'self' } as any);
    }
    await m.save(StaffLeave, { userId: t2.id, fromDate: tomorrow, toDate: tomorrow, reason: 'Việc gia đình', status: 'approved', requestedBy: t2.id, decidedBy: admin.id, decidedAt: new Date() } as any);
    await m.save(StaffSubstitution, { date: tomorrow, shiftId: shift.id, classId: classes[2].id, absentUserId: t2.id, substituteUserId: t1.id, reason: 'Cô Mai nghỉ phép', createdBy: admin.id } as any);

    // ── finance entries (one pending > 10M)
    const cat = async (kind: 'in' | 'out', like: string) => (await m.query(`SELECT id FROM finance_categories WHERE kind = $1 AND is_active ORDER BY (name ILIKE $2) DESC, sort_order LIMIT 1`, [kind, `%${like}%`]))[0]?.id;
    const fe = [
      { kind: 'out', date: addDays(today, -6), title: 'Mua rau củ, thịt cá tuần 1', amount: 4_850_000, like: 'ăn' },
      { kind: 'out', date: addDays(today, -4), title: 'Tiền điện tháng 9', amount: 2_340_000, like: 'điện' },
      { kind: 'out', date: addDays(today, -2), title: 'Văn phòng phẩm, giấy màu', amount: 650_000, like: 'văn phòng' },
      { kind: 'in', date: addDays(today, -3), title: 'Hội phụ huynh tài trợ Trung thu', amount: 3_000_000, like: 'khác' },
      { kind: 'out', date: today, title: 'Sửa mái che sân chơi', amount: 12_500_000, like: 'sửa', pending: true },
    ];
    for (const e of fe) await m.save(FinanceEntry, { kind: e.kind, date: e.date, title: e.title, amount: e.amount, categoryId: await cat(e.kind as any, e.like),
      status: e.pending ? 'pending' : 'approved', requiresApproval: !!e.pending, createdBy: acct.id, decidedBy: e.pending ? null : admin.id, decidedAt: e.pending ? null : new Date() } as any);

    // ── announcements: one sent (with inbox rows), one scheduled tomorrow 07:30
    const sent = await m.save(Announcement, { title: 'Lễ hội Trung thu 2026 🏮', body: 'Kính mời quý phụ huynh cùng bé tham dự lễ hội Trung thu lúc 16:00 thứ Sáu tuần sau tại sân trường. Bé mặc trang phục tự do, mang theo lồng đèn.',
      scope: 'school', audience: 'all', important: true, createdBy: admin.id, status: 'sent', sentAt: new Date() } as any);
    const users = await m.find(User, { where: { isActive: true } });
    const rec = users.filter((u) => u.id !== admin.id);
    await m.save(Notification, rec.map((u) => ({ userId: u.id, type: 'announcement' as const, title: sent.title, body: sent.body, important: true, announcementId: sent.id,
      data: { announcementId: sent.id, scope: 'school', important: true, audience: 'all', attachments: 0 } })) as any);
    await m.update(Announcement, sent.id, { recipientCount: rec.length } as any);
    await m.save(Announcement, { title: 'Nhắc lịch khám sức khoẻ định kỳ', body: 'Sáng thứ Ba tuần sau, trạm y tế xã đến khám sức khoẻ cho các bé. Phụ huynh cho bé ăn sáng đầy đủ.',
      scope: 'school', audience: 'parents', createdBy: admin.id, status: 'scheduled', scheduledAt: new Date(`${tomorrow}T07:30:00+07:00`) } as any);

    // ── menu for this week (skip dates/meals already set)
    const menu = [
      ['Cháo thịt bằm, sữa tươi', 'Cơm, canh bí đỏ, cá kho', 'Sữa chua, chuối'], ['Bún bò, sữa tươi', 'Cơm, canh rau ngót, thịt rim', 'Bánh flan'],
      ['Mì gà, sữa tươi', 'Cơm, canh chua, trứng chiên', 'Đu đủ'], ['Phở bò, sữa tươi', 'Cơm, canh cải, tôm rim', 'Sữa đậu nành, bánh quy'],
      ['Xôi đậu xanh, sữa tươi', 'Cơm, canh mồng tơi, gà kho gừng', 'Thanh long'],
    ];
    for (const [i, d] of menu.entries()) for (const [j, meal] of (['breakfast', 'lunch', 'snack'] as const).entries()) {
      const date = addDays(monday, i);
      if (!(await m.findOne(MenuItem, { where: { date, meal } }))) await m.save(MenuItem, { date, meal, dishes: d[j], allergyNotes: i === 3 && j === 1 ? 'Dị ứng tôm: thay tôm rim bằng gà rim' : null, updatedBy: admin.id } as any);
    }
  });
  summary.registered = await demoLoaded(ds);
  return summary;
}

if (require.main === module) {
  (async () => {
    const { default: dataSource } = await import('./data-source');
    const cmd = process.argv[2];
    await dataSource.initialize();
    try {
      if (cmd === 'load') console.log('demo:load', JSON.stringify(await demoLoad(dataSource)));
      else if (cmd === 'purge') console.log('demo:purge', JSON.stringify(await demoPurge(dataSource)));
      else throw new Error('usage: demo.ts load|purge');
    } finally { await dataSource.destroy(); }
  })().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
