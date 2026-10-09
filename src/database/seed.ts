import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { addDays, todayStr } from '../common/dates';
import dataSource from './data-source';
import { Attendance, AttendanceHistory, Child, ClassRoom, ClassTeacher, Guardian, User } from './entities';

export const SEED_PASSWORD = '123456';

/** Wipes all app tables and inserts deterministic sample data. Returns handy ids (used by e2e tests). */
export async function seed(ds: DataSource) {
  await ds.query('TRUNCATE pickup_requests, attendance_history, pickups, attendance, guardians, children, class_teachers, classes, users RESTART IDENTITY CASCADE');
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
    note: i % 9 === 0 ? 'Phụ huynh xin nghỉ' : null, recordedBy: admin.id,
  })));
  await ds.getRepository(AttendanceHistory).save(attRows.map((a) => ({
    attendanceId: a.id, action: 'create' as const, oldStatus: null, oldNote: null, newStatus: a.status, newNote: a.note, changedBy: admin.id,
  })));

  return { users: { admin, gv1, gv2, gv3, ketoan, ph1, ph2 }, classes: { c1, c2, c3 }, kids };
}

if (require.main === module) {
  (async () => {
    await dataSource.initialize();
    const r = await seed(dataSource);
    console.log(`Seeded ${Object.keys(r.users).length} users, 3 classes, ${r.kids.length} children. Password for all accounts: ${SEED_PASSWORD}`);
    await dataSource.destroy();
  })().catch((e) => { console.error(e); process.exit(1); });
}
