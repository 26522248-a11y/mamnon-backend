import { doseLate } from '../messages/parent-messages.controller';
import { vnNowHM } from '../common/school';
import { confirmedHolidays } from '../absences/absences.service';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsDateString, IsOptional } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { AuthUser, CurrentUser } from '../common/auth';
import { todayStr } from '../common/dates';
import { Child } from '../database/entities';

export class DashboardQuery {
  @ApiPropertyOptional({ example: '2026-10-09', description: 'Mặc định hôm nay (giờ VN)' }) @IsOptional() @IsDateString() date?: string;
}

/**
 * Attendance counts for a day, scoped by role:
 *  admin: whole school + per class; teacher: own classes + per class;
 *  accountant: school totals only; parent: own children (+ each child's status).
 */
@ApiTags('dashboard') @ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(@InjectRepository(Child) private children: Repository<Child>, private ds: DataSource) {}

  @Get('summary')
  async summary(@CurrentUser() u: AuthUser, @Query() q: DashboardQuery) {
    const date = q.date ?? todayStr();
    const qb = this.children.createQueryBuilder('c')
      .leftJoin('c.classRoom', 'cl')
      .leftJoin('attendance', 'a', 'a.child_id = c.id AND a.date = :date', { date })
      .where("c.status = 'active'");
    if (u.role === 'teacher') qb.andWhere('c.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('c.id = ANY(:kids)', { kids: u.childIds });
    const rows: { childId: string; fullName: string; classId: string | null; className: string | null; status: string | null }[] = await qb
      .select('c.id', 'childId').addSelect('c.full_name', 'fullName').addSelect('c.class_id', 'classId').addSelect('cl.name', 'className')
      .addSelect('a.status', 'status').orderBy('cl.name', 'ASC').addOrderBy('c.full_name', 'ASC').getRawMany();

    const count = (list: typeof rows) => ({
      totalChildren: list.length,
      present: list.filter((r) => r.status === 'present').length,
      late: list.filter((r) => r.status === 'late').length,
      absent: list.filter((r) => r.status === 'absent').length,
      unmarked: list.filter((r) => !r.status).length,
    });
    const scope = u.role === 'admin' || u.role === 'accountant' ? 'school' : u.role === 'teacher' ? 'own_classes' : 'own_children';
    const base = { date, scope, ...count(rows) };
    if (u.role === 'accountant') return base;
    if (u.role === 'parent') return { ...base, children: rows.map((r) => ({ childId: r.childId, fullName: r.fullName, className: r.className, status: r.status })) };
    const classIds = [...new Set(rows.map((r) => r.classId))];
    if (u.role === 'teacher') for (const id of u.classIds) if (!classIds.includes(id)) classIds.push(id); // empty classes still listed
    const byClass = classIds.map((id) => {
      const list = rows.filter((r) => r.classId === id);
      return { classId: id, className: list[0]?.className ?? null, ...count(list) };
    });
    if (u.role !== 'admin') return { ...base, byClass };
    return { ...base, byClass, attention: await this.attention(date, byClass) };
  }

  /** Admin "cần chú ý" block for the day. */
  private async attention(date: string, byClass: { classId: string | null; className: string | null; totalChildren: number; unmarked: number }[]) {
    const allergy: any[] = await this.ds.query(`
      SELECT c.id AS "childId", c.full_name AS "fullName", c.class_id AS "classId", cl.name AS "className", c.allergies, a.status
      FROM children c JOIN attendance a ON a.child_id = c.id AND a.date = $1 LEFT JOIN classes cl ON cl.id = c.class_id
      WHERE c.status = 'active' AND a.status IN ('present','late') AND COALESCE(btrim(c.allergies), '') <> ''
      ORDER BY cl.name, c.full_name`, [date]);
    const [{ n: pending }] = await this.ds.query(`
      SELECT COUNT(*)::int AS n FROM pickup_requests pr JOIN attendance a ON a.id = pr.attendance_id
      WHERE pr.status = 'pending' AND (pr.expires_at IS NULL OR pr.expires_at > now()) AND a.date = $1`, [date]);
    const holiday = (await confirmedHolidays(this.ds.manager, date, date)).get(date);
    // confirmed school holiday: nothing to mark
    const notMarked = holiday ? [] : byClass.filter((c) => c.classId && c.totalChildren > 0 && c.unmarked === c.totalChildren);
    const partly = holiday ? [] : byClass.filter((c) => c.classId && c.unmarked > 0 && c.unmarked < c.totalChildren);
    // medicine doses due (time + MEDICINE_LATE_MINUTES passed) and not given; child not absent that day
    const doses: any[] = holiday ? [] : await this.ds.query(`
      SELECT c.id AS "childId", c.full_name AS "fullName", c.class_id AS "classId", cl.name AS "className",
             m.id AS "medicineId", m.name AS "medicineName", d.id AS "doseId", d.time
      FROM medicine_doses d JOIN medicines m ON m.id = d.medicine_id JOIN children c ON c.id = m.child_id
      LEFT JOIN classes cl ON cl.id = c.class_id
      LEFT JOIN attendance a ON a.child_id = c.id AND a.date = m.date
      WHERE m.date = $1 AND m.cancelled_at IS NULL AND d.given_at IS NULL AND c.status = 'active' AND (a.status IS NULL OR a.status <> 'absent')
      ORDER BY d.time, cl.name, c.full_name`, [date]);
    const today = todayStr(), nowHM = vnNowHM();
    const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
    const due = doses.filter((d) => doseLate(date, d.time, null, today, nowHM)).map((d) => ({
      ...d, minutesLate: date < today ? null : toMin(nowHM) - toMin(d.time) }));
    return {
      holiday: holiday ? { id: holiday.id, name: holiday.name } : null,
      /** today's medicine doses not given MEDICINE_LATE_MINUTES after their time */
      medicinesNotGiven: due, medicinesNotGivenCount: due.length,
      /** classes with active children and no attendance at all for the day */
      classesNotMarked: notMarked.map((c) => ({ classId: c.classId, className: c.className, totalChildren: c.totalChildren })),
      classesNotMarkedCount: notMarked.length,
      /** classes where some children are still unmarked */
      classesPartlyMarked: partly.map((c) => ({ classId: c.classId, className: c.className, totalChildren: c.totalChildren, unmarked: c.unmarked })),
      allergyChildrenPresent: allergy.map((r) => ({ childId: r.childId, fullName: r.fullName, classId: r.classId, className: r.className, allergies: r.allergies, status: r.status })),
      allergyChildrenPresentCount: allergy.length,
      /** pending, not yet expired pickup requests for that day */
      pendingPickupRequests: Number(pending),
    };
  }
}
