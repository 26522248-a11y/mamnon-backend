import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { addDays, todayStr } from '../common/dates';
import dataSource from './data-source';
import * as fs from 'fs';
import * as path from 'path';
import { writePlaceholderAvatar } from '../common/avatar';
import { uploadDir } from '../common/upload';
import { Announcement, Attendance, AttendanceHistory, Child, CreditTransaction, Notification, DailyNote, FeeItem, GrowthRecord, Invoice, MenuItem, Payment, ClassRoom, ClassTeacher, Guardian, User } from './entities';

export const SEED_PASSWORD = '123456';

/** Wipes all app tables and inserts deterministic sample data. Returns handy ids (used by e2e tests). */
export async function seed(ds: DataSource) {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed (password 123456) is disabled in production – use npm run bootstrap:admin');
  await ds.query('TRUNCATE absence_events, absence_days, absences, holidays, medicine_doses, medicines, late_pickups, audit_events, child_contact_history, notification_deliveries, push_subscriptions, sensitive_access_logs, pickup_call_attempts, pickup_duties, authorized_picker_history, authorized_pickers, refund_payouts, meal_refunds, invoice_audit, notifications, announcements, credit_transactions, payments, invoice_lines, invoices, fee_items, growth_records, menus, daily_notes, pickup_requests, attendance_history, pickups, attendance, guardians, children, class_teachers, classes, users RESTART IDENTITY CASCADE');
  const hash = await bcrypt.hash(SEED_PASSWORD, 10);
  const mk = (username: string, name: string, role: User['role'], phone: string | null = null) =>
    ds.getRepository(User).save({ username, name, role, phone, passwordHash: hash });

  const admin = await mk('admin', 'Cô Hiệu trưởng', 'admin');
  const gv1 = await mk('gv1', 'Cô Lan', 'teacher', '0901000001');
  const gv2 = await mk('gv2', 'Cô Mai', 'teacher', '0901000002');
  const gv3 = await mk('gv3', 'Cô Hồng', 'teacher', '0901000003');
  const ketoan = await mk('ketoan', 'Chị Kế toán', 'accountant');
  const ph1 = await mk('ph1', 'Phụ huynh bé An', 'parent', '0912000001');
  const ph2 = await mk('ph2', 'Phụ huynh bé Bình', 'parent', '0912000002');

  const classRepo = ds.getRepository(ClassRoom);
  const c1 = await classRepo.save({ name: 'Mầm 1', ageGroup: '3-4 tuổi', schoolYear: '2026-2027', room: 'P101', capacity: 25 });
  const c2 = await classRepo.save({ name: 'Chồi 1', ageGroup: '4-5 tuổi', schoolYear: '2026-2027', room: 'P102', capacity: 25 });
  const c3 = await classRepo.save({ name: 'Lá 1', ageGroup: '5-6 tuổi', schoolYear: '2026-2027', room: 'P201', capacity: 30 });
  const classes = [c1, c2, c3];
  await ds.getRepository(ClassTeacher).save([
    { classId: c1.id, userId: gv1.id, isHead: true }, { classId: c2.id, userId: gv2.id, isHead: true }, { classId: c3.id, userId: gv3.id, isHead: true },
  ]);

  const ho = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ'];
  const dem = ['Gia', 'Minh', 'Bảo', 'Khánh'];
  const ten = ['An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Khôi', 'Linh', 'Minh', 'Ngọc', 'Phúc'];
  const birthYear = [2023, 2022, 2021];
  const kids: Child[] = [];
  for (let i = 0; i < 30; i++) {
    const ci = i % 3;
    kids.push(await ds.getRepository(Child).save({
      fullName: `${ho[i % 6]} ${dem[i % 4]} ${ten[i % 10]}`,
      dob: `${birthYear[ci]}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      gender: i % 2 ? 'F' : 'M', classId: classes[ci].id,
      allergies: i % 7 === 0 ? 'Đậu phộng' : null, healthNotes: i % 10 === 3 ? 'Hen suyễn nhẹ, mang theo thuốc xịt' : null,
      address: `${10 + i} Lê Lợi, Q.1, TP.HCM`, enrolledAt: '2026-09-05', status: 'active',
    }));
  }
  // placeholder avatars (real PNG, one file per child); old seed avatars are removed first
  for (const f of fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()) : []) if (/^avatar-.*\.png$/.test(f)) fs.rmSync(path.join(uploadDir(), f), { force: true });
  for (const [i, k] of kids.entries()) { k.photoUrl = writePlaceholderAvatar(k.id, i); await ds.getRepository(Child).update(k.id, { photoUrl: k.photoUrl }); }
  // kids[0] = "Nguyễn Gia An" (Mầm 1), kids[1] = "Trần Minh Bình" (Chồi 1)
  const gRepo = ds.getRepository(Guardian);
  for (const [idx, k] of kids.entries()) {
    const last = k.fullName.split(' ')[0];
    await gRepo.save({ childId: k.id, fullName: `${last} Văn ${['Hùng', 'Nam', 'Tuấn'][idx % 3]}`, relation: 'Bố', phone: `0913${String(idx).padStart(6, '0')}`,
      userId: idx === 0 ? ph1.id : idx === 1 ? ph2.id : null, canPickup: true });
    await gRepo.save({ childId: k.id, fullName: `${['Trần', 'Lê', 'Phạm'][idx % 3]} Thị ${['Hoa', 'Thu', 'Lan'][idx % 3]}`, relation: 'Mẹ', phone: `0914${String(idx).padStart(6, '0')}`, canPickup: true });
  }
  await gRepo.save({ childId: kids[0].id, fullName: 'Nguyễn Thị Bà', relation: 'Bà nội', canPickup: false });

  // attendance for yesterday in every class
  const y = addDays(todayStr(), -1);
  const attRows = await ds.getRepository(Attendance).save(kids.map((k, i) => ({
    childId: k.id, classId: k.classId!, date: y, status: (i % 9 === 0 ? 'absent' : i % 5 === 0 ? 'late' : 'present') as any,
    note: i % 9 === 0 ? 'Phụ huynh xin nghỉ' : null, notifiedInAdvance: i % 9 === 0, recordedBy: admin.id,
  })));
  await ds.getRepository(AttendanceHistory).save(attRows.map((a) => ({
    attendanceId: a.id, action: 'create' as const, oldStatus: null, oldNote: null, oldNotified: null, newStatus: a.status, newNote: a.note,
    newNotified: a.notifiedInAdvance, changedBy: admin.id,
  })));

  await ds.query('ALTER SEQUENCE invoice_no_seq RESTART WITH 1');
  await ds.query('ALTER SEQUENCE receipt_no_seq RESTART WITH 1');
  await ds.query('ALTER SEQUENCE payout_no_seq RESTART WITH 1');

  // ── fees: school-wide monthly tuition + meals, class add-on, one child-specific item
  const fRepo = ds.getRepository(FeeItem);
  const tuition = await fRepo.save({ name: 'Học phí', amount: 1_500_000, type: 'monthly', scope: 'school' });
  const meals = await fRepo.save({ name: 'Tiền ăn', amount: 900_000, type: 'monthly', scope: 'school', mealRefundPerDay: 40_000 });
  const english = await fRepo.save({ name: 'Tiếng Anh', amount: 300_000, type: 'monthly', scope: 'class', classId: c3.id });
  const art = await fRepo.save({ name: 'Năng khiếu vẽ', amount: 200_000, type: 'monthly', scope: 'child', childId: kids[0].id });
  await fRepo.save({ name: 'Đồng phục', amount: 250_000, type: 'one_time', scope: 'school' });
  // kids[4] has an older sibling at school -> monthly discount
  const sibling = await fRepo.save({ name: 'Giảm trừ anh chị em ruột', amount: 150_000, type: 'discount', scope: 'child', childId: kids[4].id, reason: 'Anh chị em ruột cùng học tại trường' });
  const today = todayStr(), thisMonth = today.slice(0, 7);
  const [yy, mm] = thisMonth.split('-').map(Number);
  const lastMonth = mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, '0')}`;
  const iRepo = ds.getRepository(Invoice), pRepo = ds.getRepository(Payment);
  const nextNo = async (seq: string, prefix: string, period: string) =>
    `${prefix}${period.replace('-', '')}-${String((await ds.query(`SELECT nextval('${seq}') AS n`))[0].n).padStart(5, '0')}`;
  for (const period of [lastMonth, thisMonth]) {
    for (const [i, k] of kids.entries()) {
      const fees = [tuition, meals, ...(k.classId === c3.id ? [english] : []), ...(k.id === kids[0].id ? [art] : [])];
      const discounts = k.id === kids[4].id ? [sibling] : [];
      const total = fees.reduce((sum, f) => sum + f.amount, 0) - discounts.reduce((sum, f) => sum + f.amount, 0);
      // last month: most paid, every 6th partial, every 10th unpaid; this month: a third paid
      const paid = period === lastMonth ? (i % 10 === 9 ? 0 : i % 6 === 5 ? 1_000_000 : total) : (i % 3 === 0 ? total : 0);
      const inv = await iRepo.save(iRepo.create({
        invoiceNo: await nextNo('invoice_no_seq', 'HD', period), childId: k.id, classId: k.classId, period,
        issueDate: `${period}-01`, dueDate: `${period}-10`, totalAmount: total, paidAmount: paid,
        status: paid === 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial', createdBy: ketoan.id,
        lines: [
          ...fees.map((f) => ({ feeItemId: f.id, kind: 'charge', description: f.name, quantity: 1, unitPrice: f.amount, amount: f.amount })),
          ...discounts.map((f) => ({ feeItemId: f.id, kind: 'discount', description: f.name, quantity: 1, unitPrice: f.amount, amount: -f.amount, reason: f.reason })),
        ] as any,
      }));
      if (paid > 0) await pRepo.save({ receiptNo: await nextNo('receipt_no_seq', 'PT', period), invoiceId: inv.id, childId: k.id, amount: paid,
        method: i % 2 ? 'cash' : 'transfer', paidAt: new Date(`${period}-0${(i % 8) + 2}T09:00:00+07:00`), receivedBy: ketoan.id,
        payerName: null });
    }
  }

  // prepayment: kids[7]'s family paid 500.000đ in advance (credit applied to next invoice)
  const pre = await pRepo.save({ receiptNo: await nextNo('receipt_no_seq', 'PT', thisMonth), invoiceId: null, childId: kids[7].id, amount: 500_000,
    creditAmount: 500_000, method: 'transfer', paidAt: new Date(), receivedBy: ketoan.id, payerName: 'Phụ huynh', note: 'Trả trước' });
  await ds.getRepository(CreditTransaction).save({ childId: kids[7].id, amount: 500_000, type: 'prepayment', paymentId: pre.id, note: `Trả trước ở phiếu ${pre.receiptNo}`, createdBy: ketoan.id });

  // ── announcements + inbox
  const annRepo = ds.getRepository(Announcement), nRepo = ds.getRepository(Notification);
  const a1 = await annRepo.save({ title: 'Họp phụ huynh đầu năm', body: 'Kính mời quý phụ huynh dự họp lúc 8h sáng Chủ nhật tại hội trường.', scope: 'school', audience: 'all', createdBy: admin.id });
  const a2 = await annRepo.save({ title: 'Lớp Mầm 1: mang áo mưa', body: 'Mùa mưa, phụ huynh vui lòng để áo mưa trong balo của bé.', scope: 'class', classId: c1.id, audience: 'parents', createdBy: gv1.id });
  const everyone = [gv1, gv2, gv3, ketoan, ph1, ph2];
  await nRepo.save(everyone.map((x) => ({ userId: x.id, type: 'announcement' as const, title: a1.title, body: a1.body, announcementId: a1.id, data: { announcementId: a1.id, scope: 'school' } })));
  await nRepo.save({ userId: ph1.id, type: 'announcement', title: a2.title, body: a2.body, announcementId: a2.id, data: { announcementId: a2.id, scope: 'class', classId: c1.id } });

  // ── health: two growth measurements per child
  const gr = ds.getRepository(GrowthRecord);
  for (const [i, k] of kids.entries()) {
    const ci = classes.findIndex((c) => c.id === k.classId);
    const h = 95 + ci * 7 + (i % 5), w = 14 + ci * 2 + (i % 4) * 0.5;
    await gr.save([
      { childId: k.id, date: `${lastMonth}-05`, heightCm: h, weightKg: w, recordedBy: admin.id },
      { childId: k.id, date: `${thisMonth}-05` <= today ? `${thisMonth}-05` : `${lastMonth}-25`, heightCm: h + 0.8, weightKg: w + 0.3, recordedBy: admin.id },
    ]);
  }
  // ── weekly menu for this week (Mon–Fri)
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  const menu = [
    ['Cháo thịt bằm, sữa tươi', 'Cơm, canh bí đỏ, cá kho', 'Sữa chua, chuối'],
    ['Bún bò, sữa tươi', 'Cơm, canh rau ngót, thịt rim', 'Bánh flan'],
    ['Mì gà, sữa tươi', 'Cơm, canh chua, trứng chiên', 'Đu đủ'],
    ['Phở bò, sữa tươi', 'Cơm, canh cải, tôm rim', 'Sữa đậu nành, bánh quy'],
    ['Xôi đậu xanh, sữa tươi', 'Cơm, canh mồng tơi, gà kho gừng', 'Thanh long'],
  ];
  const allergy: Record<string, string> = {
    '0-1': 'Dị ứng cá: thay cá kho bằng thịt heo kho', '3-1': 'Dị ứng hải sản: thay tôm rim bằng gà rim', '1-2': 'Dị ứng trứng/sữa: thay bánh flan bằng chuối',
  };
  await ds.getRepository(MenuItem).save(menu.flatMap((d, i) => (['breakfast', 'lunch', 'snack'] as const).map((meal, j) =>
    ({ date: addDays(monday, i), meal, dishes: d[j], allergyNotes: allergy[`${i}-${j}`] ?? null, updatedBy: admin.id }))));
  // ── daily notes for yesterday
  await ds.getRepository(DailyNote).save(kids.map((k, i) => ({
    childId: k.id, classId: k.classId!, date: y, eating: (['all', 'most', 'half', 'all', 'little'] as const)[i % 5],
    sleepMinutes: 90 + (i % 4) * 15, mood: i % 6 === 0 ? 'Hơi mệt' : 'Vui vẻ', toilet: 'Bình thường',
    note: null, recordedBy: admin.id,
  })).filter((_, i) => i % 9 !== 0)); // absent kids have no note

  return { users: { admin, gv1, gv2, gv3, ketoan, ph1, ph2 }, classes: { c1, c2, c3 }, kids, fees: { tuition, meals, english, art }, periods: { lastMonth, thisMonth } };
}

if (require.main === module) {
  (async () => {
    // Demo data only: creates admin/gv1/ketoan/ph1… with password 123456. Never in production (use npm run bootstrap:admin).
    if (process.env.NODE_ENV === 'production') {
      console.error('Refusing to run the DEMO seed with NODE_ENV=production (it creates accounts with password 123456 and wipes data). Use: npm run bootstrap:admin');
      process.exit(3);
    }
    await dataSource.initialize();
    // Safety: seeding wipes every table. Refuse on a database that already has data unless --force is given.
    const [{ n }] = await dataSource.query('SELECT COUNT(*)::int AS n FROM users');
    if (n > 0 && !process.argv.includes('--force')) {
      console.error(`Database already has ${n} users. Seeding would DELETE all data. Re-run with: npm run seed -- --force`);
      await dataSource.destroy();
      process.exit(2);
    }
    const r = await seed(dataSource);
    console.log(`Seeded ${Object.keys(r.users).length} users, 3 classes, ${r.kids.length} children. Password for all accounts: ${SEED_PASSWORD}`);
    await dataSource.destroy();
  })().catch((e) => { console.error(e); process.exit(1); });
}
