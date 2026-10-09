import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsDateString, IsOptional } from 'class-validator';
import { Repository } from 'typeorm';
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
  constructor(@InjectRepository(Child) private children: Repository<Child>) {}

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
    return {
      ...base,
      byClass: classIds.map((id) => {
        const list = rows.filter((r) => r.classId === id);
        return { classId: id, className: list[0]?.className ?? null, ...count(list) };
      }),
    };
  }
}
