import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { Request } from 'express';
import { Between, DataSource, EntityManager, In, IsNull, LessThanOrEqual, MoreThanOrEqual, Not } from 'typeorm';
import { recordAudit } from '../common/audit';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { addDays, todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import {
  ClassRoom, StaffCheckin, StaffLeave, StaffShift, StaffShiftAssignment, StaffSubstitution, User,
} from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';
import { datesBetween, HM_RE, isoWeekday, minutesOf, vnAt, vnDate, vnHm } from './staff-time';

// ───────────────────────── DTOs ─────────────────────────
export class ShiftDto {
  @ApiProperty({ example: 'Ca sáng' }) @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @ApiProperty({ example: '07:00' }) @Matches(HM_RE, { message: 'startTime: HH:MM' }) startTime!: string;
  @ApiProperty({ example: '16:00' }) @Matches(HM_RE, { message: 'endTime: HH:MM' }) endTime!: string;
  @ApiPropertyOptional({ default: 5 }) @IsOptional() @IsInt() @Min(0) @Max(120) lateGraceMinutes?: number;
}
export class UpdateShiftDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HM_RE) startTime?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HM_RE) endTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(120) lateGraceMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class AssignDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty() @IsUUID() shiftId!: string;
  @ApiPropertyOptional({ description: 'Lớp phụ trách trong ca' }) @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Danh sách ngày; hoặc dùng from/to (+weekdays)' }) @IsOptional() @IsArray() @ArrayMaxSize(93) @IsDateString({}, { each: true }) dates?: string[];
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ type: [Number], description: 'Thứ trong tuần khi dùng from/to: 1 = T2 … 7 = CN (mặc định 1–5)', example: [1, 2, 3, 4, 5] })
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) weekdays?: number[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class RangeQuery {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
}
export class AttendanceQuery extends RangeQuery {
  @ApiPropertyOptional({ description: 'Ngày cho các ô tổng (mặc định hôm nay nếu nằm trong khoảng, nếu không là "to")' }) @IsOptional() @IsDateString() date?: string;
}
export class CheckDto { @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string; }
export class CorrectCheckinDto {
  @ApiPropertyOptional({ description: 'ISO 8601; null = xoá' }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() checkInAt?: string | null;
  @ApiPropertyOptional({ description: 'ISO 8601; null = xoá' }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() checkOutAt?: string | null;
  @ApiProperty({ description: 'Lý do sửa (bắt buộc)' }) @IsString() @MinLength(1) @MaxLength(300) note!: string;
}
export class LeaveDto {
  @ApiProperty({ example: '2026-10-10' }) @IsDateString() fromDate!: string;
  @ApiProperty({ example: '2026-10-10' }) @IsDateString() toDate!: string;
  @ApiProperty({ example: 'Việc gia đình' }) @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ description: 'Chỉ admin: tạo phép cho người khác (được duyệt luôn)' }) @IsOptional() @IsUUID() userId?: string;
}
export class LeaveQuery extends RangeQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected', 'cancelled'] }) @IsOptional() @IsIn(['pending', 'approved', 'rejected', 'cancelled']) status?: string;
}
export class DecideDto { @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string; }
export class SubstitutionDto {
  @ApiProperty() @IsDateString() date!: string;
  @ApiProperty() @IsUUID() shiftId!: string;
  @ApiProperty() @IsUUID() classId!: string;
  @ApiProperty() @IsUUID() substituteUserId!: string;
  @ApiPropertyOptional({ description: 'Mặc định: GV được xếp lớp đó trong ca' }) @IsOptional() @IsUUID() absentUserId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
  @ApiPropertyOptional({ description: 'Cho phép dù người trông thay đã có ca trùng giờ' }) @IsOptional() @IsBoolean() force?: boolean;
}
export class NeedsQuery {
  @ApiPropertyOptional({ description: 'Mặc định hôm nay' }) @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

export type DayStatus = 'full' | 'late' | 'leave' | 'absent' | 'substitute' | 'pending' | 'off';
const STAFF_ROLES = ['admin', 'teacher', 'accountant'];
const d10 = (s: string) => s.slice(0, 10);
const shiftView = (s: StaffShift | null | undefined) => s ? { id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime, lateGraceMinutes: s.lateGraceMinutes, isActive: s.isActive } : null;
const person = (u: User | null | undefined, id?: string | null) => (u ? { id: u.id, name: u.name, role: u.role } : id ? { id, name: null, role: null } : null);
/** Monday..Friday of the week containing `d` */
const weekOf = (d: string) => { const mon = addDays(d, 1 - isoWeekday(d)); return { from: mon, to: addDays(mon, 4) }; };

/**
 * Quản lý giáo viên (đợt 3): ca làm, xếp ca, chấm công vào/ra ca, nghỉ phép, trông thay.
 * Admin quản lý; giáo viên / kế toán xem của mình và tự chấm công. Kế toán không xếp ca.
 */
@ApiTags('staff') @ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(private ds: DataSource, private notify: NotificationsService) {}

  // ───────────────────────── shifts ─────────────────────────
  @Get('shifts') @Roles('admin', 'teacher', 'accountant')
  @ApiOperation({ summary: 'Danh sách ca làm (mặc định chỉ ca đang dùng; admin thêm ?all=true)' })
  async shifts(@CurrentUser() u: AuthUser, @Query('all') all?: string) {
    const rows = await this.ds.getRepository(StaffShift).find({ where: u.role === 'admin' && all === 'true' ? {} : { isActive: true }, order: { startTime: 'ASC', name: 'ASC' } });
    return { items: rows.map(shiftView) };
  }

  @Post('shifts') @Roles('admin')
  async createShift(@Body() dto: ShiftDto) {
    if (minutesOf(dto.endTime) <= minutesOf(dto.startTime)) throw BadRequest('Giờ kết thúc phải sau giờ bắt đầu', 'INVALID_SHIFT_TIME');
    const s = await this.ds.getRepository(StaffShift).save({ name: dto.name.trim(), startTime: dto.startTime, endTime: dto.endTime, lateGraceMinutes: dto.lateGraceMinutes ?? 5 });
    return shiftView(s);
  }

  @Patch('shifts/:id') @Roles('admin')
  async updateShift(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateShiftDto) {
    const repo = this.ds.getRepository(StaffShift);
    const s = await repo.findOneBy({ id });
    if (!s) throw NotFound('Không tìm thấy ca');
    Object.assign(s, Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)));
    if (minutesOf(s.endTime) <= minutesOf(s.startTime)) throw BadRequest('Giờ kết thúc phải sau giờ bắt đầu', 'INVALID_SHIFT_TIME');
    return shiftView(await repo.save(s));
  }

  /** Unused shift → deleted; shift already used (assignments / substitutions) → deactivated to keep history. */
  @Delete('shifts/:id') @Roles('admin') @HttpCode(200)
  async deleteShift(@Param('id', ParseUUIDPipe) id: string) {
    const s = await this.ds.getRepository(StaffShift).findOneBy({ id });
    if (!s) throw NotFound('Không tìm thấy ca');
    const used = (await this.ds.getRepository(StaffShiftAssignment).count({ where: { shiftId: id } })) + (await this.ds.getRepository(StaffSubstitution).count({ where: { shiftId: id } }));
    if (used) { await this.ds.getRepository(StaffShift).update(id, { isActive: false }); return { id, deleted: false, deactivated: true }; }
    await this.ds.getRepository(StaffShift).delete(id);
    return { id, deleted: true, deactivated: false };
  }

  // ───────────────────────── assignments (xếp ca) ─────────────────────────
  private async staffUser(m: EntityManager | DataSource, id: string, roles = STAFF_ROLES) {
    const user = await m.getRepository(User).findOneBy({ id });
    if (!user) throw NotFound('Không tìm thấy nhân viên');
    if (!roles.includes(user.role) || !user.isActive) throw BadRequest('Chỉ chọn tài khoản nhân viên đang hoạt động', 'INVALID_STAFF');
    return user;
  }
  private async activeShift(id: string) {
    const s = await this.ds.getRepository(StaffShift).findOneBy({ id });
    if (!s) throw NotFound('Không tìm thấy ca');
    if (!s.isActive) throw BadRequest('Ca đã ngừng sử dụng', 'SHIFT_INACTIVE');
    return s;
  }
  private assignmentView = (a: StaffShiftAssignment) => ({ id: a.id, date: a.date, userId: a.userId, userName: a.user?.name ?? null, shift: shiftView(a.shift),
    classId: a.classId, className: a.classRoom?.name ?? null, note: a.note });

  @Post('assignments') @Roles('admin')
  @ApiOperation({ summary: 'Xếp ca (nhiều ngày một lần). Ngày đã có cùng ca thì bỏ qua.' })
  async assign(@CurrentUser() u: AuthUser, @Body() dto: AssignDto) {
    const user = await this.staffUser(this.ds, dto.userId);
    const shift = await this.activeShift(dto.shiftId);
    if (dto.classId && !(await this.ds.getRepository(ClassRoom).exist({ where: { id: dto.classId } }))) throw NotFound('Không tìm thấy lớp');
    let dates = (dto.dates ?? []).map(d10);
    if (dto.from || dto.to) {
      if (!dto.from || !dto.to || d10(dto.to) < d10(dto.from)) throw BadRequest('Cần from ≤ to', 'INVALID_RANGE');
      const wd = dto.weekdays?.length ? dto.weekdays : [1, 2, 3, 4, 5];
      const all = datesBetween(d10(dto.from), d10(dto.to), 93);
      if (all.length >= 93 && all[all.length - 1] < d10(dto.to)) throw BadRequest('Tối đa 93 ngày mỗi lần', 'INVALID_RANGE');
      dates.push(...all.filter((d) => wd.includes(isoWeekday(d))));
    }
    dates = [...new Set(dates)].sort();
    if (!dates.length) throw BadRequest('Chưa chọn ngày', 'VALIDATION_ERROR');
    const res = await this.ds.createQueryBuilder().insert().into(StaffShiftAssignment)
      .values(dates.map((date) => ({ date, userId: user.id, shiftId: shift.id, classId: dto.classId ?? null, note: dto.note ?? null, createdBy: u.id })))
      .orIgnore().returning(['id']).execute();
    const ids = res.raw.map((r: any) => r.id);
    const rows = ids.length ? await this.ds.getRepository(StaffShiftAssignment).find({ where: { id: In(ids) }, relations: { user: true, shift: true, classRoom: true }, order: { date: 'ASC' } }) : [];
    const createdDates = new Set(rows.map((r) => r.date));
    return { created: rows.length, skippedExisting: dates.filter((d) => !createdDates.has(d)), items: rows.map(this.assignmentView) };
  }

  @Get('assignments') @Roles('admin', 'teacher', 'accountant')
  @ApiOperation({ summary: 'Lịch ca (admin: tất cả; GV / kế toán: của mình). Mặc định tuần này T2–T6.' })
  async assignments(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) {
    const { from, to } = this.range(q);
    const where: any = { date: Between(from, to) };
    if (u.role !== 'admin') where.userId = u.id; else if (q.userId) where.userId = q.userId;
    if (q.classId) where.classId = q.classId;
    const rows = await this.ds.getRepository(StaffShiftAssignment).find({ where, relations: { user: true, shift: true, classRoom: true }, order: { date: 'ASC' } });
    return { from, to, items: rows.map(this.assignmentView) };
  }

  @Delete('assignments/:id') @Roles('admin') @HttpCode(204)
  async unassign(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.ds.getRepository(StaffShiftAssignment).delete(id);
    if (!r.affected) throw NotFound('Không tìm thấy ca đã xếp');
  }

  // ───────────────────────── check-in / check-out ─────────────────────────
  @Post('me/check-in') @Roles('admin', 'teacher', 'accountant') @HttpCode(200)
  @ApiOperation({ summary: 'Vào ca (giờ máy chủ). Mỗi ngày 1 lần → 409 ALREADY_CHECKED_IN.' })
  async checkIn(@CurrentUser() u: AuthUser, @Body() dto: CheckDto, @Req() req: Request) {
    const now = new Date(), date = vnDate(now);
    const repo = this.ds.getRepository(StaffCheckin);
    const ex = await repo.findOneBy({ userId: u.id, date });
    if (ex?.checkInAt) throw new AppError(409, 'ALREADY_CHECKED_IN', `Đã vào ca lúc ${vnHm(ex.checkInAt)}`);
    if (ex) await repo.update(ex.id, { checkInAt: now, checkInIp: req.ip?.slice(0, 64) ?? null, note: dto.note ?? ex.note });
    else await repo.createQueryBuilder().insert().values({ userId: u.id, date, checkInAt: now, checkInIp: req.ip?.slice(0, 64) ?? null, note: dto.note ?? null }).orIgnore().execute();
    return this.today(u);
  }

  @Post('me/check-out') @Roles('admin', 'teacher', 'accountant') @HttpCode(200)
  @ApiOperation({ summary: 'Ra ca. Chưa vào ca → 409 NOT_CHECKED_IN; đã ra → 409 ALREADY_CHECKED_OUT.' })
  async checkOut(@CurrentUser() u: AuthUser, @Body() dto: CheckDto, @Req() req: Request) {
    const now = new Date(), date = vnDate(now);
    const repo = this.ds.getRepository(StaffCheckin);
    const ex = await repo.findOneBy({ userId: u.id, date });
    if (!ex?.checkInAt) throw new AppError(409, 'NOT_CHECKED_IN', 'Chưa vào ca hôm nay');
    if (ex.checkOutAt) throw new AppError(409, 'ALREADY_CHECKED_OUT', `Đã ra ca lúc ${vnHm(ex.checkOutAt)}`);
    await repo.update(ex.id, { checkOutAt: now, checkOutIp: req.ip?.slice(0, 64) ?? null, ...(dto.note ? { note: dto.note } : {}) });
    return this.today(u);
  }

  @Get('me/today') @Roles('admin', 'teacher', 'accountant')
  @ApiOperation({ summary: 'Màn chấm công của tôi: ca hôm nay, giờ vào/ra, trạng thái, trông thay hôm nay, công tuần này, đơn phép' })
  async today(@CurrentUser() u: AuthUser) {
    const date = todayStr(), wk = weekOf(date);
    const rep = await this.report([u.id], wk.from, wk.to);
    const row = rep.rows[0];
    const day = row.days.find((d) => d.date === date) ?? (await this.report([u.id], date, date)).rows[0].days[0];
    const subs = await this.subsQuery({ from: date, to: date }).andWhere('(s.substitute_user_id = :me OR s.absent_user_id = :me)', { me: u.id }).getMany();
    const leaves = await this.ds.getRepository(StaffLeave).find({ where: { userId: u.id, toDate: MoreThanOrEqual(date), status: In(['pending', 'approved']) }, order: { fromDate: 'ASC' } });
    return {
      date, now: new Date().toISOString(), nowTime: vnHm(new Date()),
      shifts: day.shifts, classes: day.classes, checkInAt: day.checkInAt, checkOutAt: day.checkOutAt, status: day.status, lateMinutes: day.lateMinutes,
      canCheckIn: !day.checkInAt, canCheckOut: !!day.checkInAt && !day.checkOutAt,
      substitutions: subs.map((s) => ({ ...this.subView(s), role: s.substituteUserId === u.id ? 'covering' : 'covered' })),
      week: row.days.map((d) => ({ date: d.date, weekday: isoWeekday(d.date), status: d.status, checkInAt: d.checkInAt })),
      leaves: leaves.map(this.leaveView),
    };
  }

  /** Admin correction (forgotten check-in / check-out). Audited (staff_attendance.correct). */
  @Put('attendance/:userId/:date') @Roles('admin')
  async correct(@CurrentUser() u: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Param('date') date: string, @Body() dto: CorrectCheckinDto, @Req() req: Request) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw BadRequest('date: YYYY-MM-DD');
    if (date > todayStr()) throw BadRequest('Không chấm công cho ngày tương lai', 'DATE_IN_FUTURE');
    const user = await this.staffUser(this.ds, userId);
    return this.ds.transaction(async (m) => {
      const repo = m.getRepository(StaffCheckin);
      let row = await repo.findOneBy({ userId, date });
      const before = row ? { checkInAt: row.checkInAt, checkOutAt: row.checkOutAt } : null;
      if (!row) row = repo.create({ userId, date, checkInAt: null, checkOutAt: null });
      if (dto.checkInAt !== undefined) row.checkInAt = dto.checkInAt ? new Date(dto.checkInAt) : null;
      if (dto.checkOutAt !== undefined) row.checkOutAt = dto.checkOutAt ? new Date(dto.checkOutAt) : null;
      for (const t of [row.checkInAt, row.checkOutAt]) if (t && vnDate(t) !== date) throw BadRequest('Giờ vào/ra phải thuộc đúng ngày (giờ VN)', 'VALIDATION_ERROR');
      if (row.checkInAt && row.checkOutAt && row.checkOutAt <= row.checkInAt) throw BadRequest('Giờ ra phải sau giờ vào', 'VALIDATION_ERROR');
      if (!row.checkInAt && row.checkOutAt) throw BadRequest('Có giờ ra thì phải có giờ vào', 'VALIDATION_ERROR');
      row.source = 'admin'; row.note = dto.note.trim();
      await repo.save(row);
      await recordAudit(m, u, { action: 'staff_attendance.correct', entityType: 'staff_checkin', entityId: row.id, before, after: { checkInAt: row.checkInAt, checkOutAt: row.checkOutAt },
        reason: row.note, ip: req.ip ?? null, targetLabel: `${user.name} · ${date}` });
      return { userId, date, checkInAt: row.checkInAt, checkOutAt: row.checkOutAt, source: row.source, note: row.note };
    });
  }

  // ───────────────────────── attendance report ─────────────────────────
  private range(q: { from?: string; to?: string }, maxDays = 62) {
    const wk = weekOf(todayStr());
    const from = q.from ? d10(q.from) : wk.from, to = q.to ? d10(q.to) : (q.from ? addDays(d10(q.from), 6) : wk.to);
    if (to < from) throw BadRequest('from phải ≤ to', 'INVALID_RANGE');
    if (datesBetween(from, to, maxDays + 1).length > maxDays) throw BadRequest(`Tối đa ${maxDays} ngày`, 'INVALID_RANGE');
    return { from, to };
  }

  /** per user × day: shifts, check-in/out, status (full | late | leave | absent | substitute | pending | off) */
  private async report(userIds: string[] | null, from: string, to: string) {
    const dates = datesBetween(from, to);
    const today = todayStr(), now = new Date();
    const asg = await this.ds.getRepository(StaffShiftAssignment).find({ where: { date: Between(from, to), ...(userIds ? { userId: In(userIds) } : {}) }, relations: { shift: true, classRoom: true } });
    const subs = await this.subsQuery({ from, to }).getMany();
    const ci = await this.ds.getRepository(StaffCheckin).find({ where: { date: Between(from, to), ...(userIds ? { userId: In(userIds) } : {}) } });
    const lv = await this.ds.getRepository(StaffLeave).find({ where: { status: 'approved', fromDate: LessThanOrEqual(to), toDate: MoreThanOrEqual(from), ...(userIds ? { userId: In(userIds) } : {}) } });
    let ids = userIds;
    if (!ids) {
      const teachers = await this.ds.getRepository(User).find({ where: { role: 'teacher', isActive: true }, select: { id: true } });
      ids = [...new Set([...teachers.map((t) => t.id), ...asg.map((a) => a.userId), ...ci.map((c) => c.userId), ...lv.map((l) => l.userId), ...subs.map((s) => s.substituteUserId)])];
    }
    const users = ids.length ? await this.ds.getRepository(User).find({ where: { id: In(ids) } }) : [];
    users.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    const rows = users.map((user) => {
      const days = dates.map((date) => {
        const own = asg.filter((a) => a.userId === user.id && a.date === date).sort((a, b) => a.shift.startTime.localeCompare(b.shift.startTime));
        const covering = subs.filter((s) => s.substituteUserId === user.id && s.date === date);
        const coveredBy = subs.filter((s) => s.absentUserId === user.id && s.date === date);
        const c = ci.find((x) => x.userId === user.id && x.date === date) ?? null;
        const leave = lv.find((l) => l.userId === user.id && l.fromDate <= date && l.toDate >= date) ?? null;
        const shifts = [...own.map((a) => a.shift), ...covering.map((s) => s.shift)].sort((a, b) => a.startTime.localeCompare(b.startTime));
        const first = shifts[0] ?? null;
        const lastEnd = shifts.map((s) => s.endTime).sort().pop() ?? null;
        let status: DayStatus, lateMinutes = 0;
        if (c?.checkInAt) {
          if (first) lateMinutes = Math.max(0, Math.round((c.checkInAt.getTime() - vnAt(date, first.startTime).getTime()) / 60000));
          const late = !!first && lateMinutes > first.lateGraceMinutes;
          status = covering.length ? 'substitute' : late ? 'late' : 'full';
          if (!late) lateMinutes = 0;
        } else if (leave) status = 'leave';
        else if (own.length || covering.length) status = date < today || (date === today && lastEnd && now >= vnAt(date, lastEnd)) ? 'absent' : 'pending';
        else status = 'off';
        return {
          date, status, lateMinutes, checkInAt: c?.checkInAt ?? null, checkOutAt: c?.checkOutAt ?? null, checkInSource: c?.source ?? null,
          shifts: [...new Map(shifts.map((s) => [s.id, shiftView(s)])).values()],
          classes: own.filter((a) => a.classId).map((a) => ({ id: a.classId, name: a.classRoom?.name ?? null, shiftId: a.shiftId })),
          substituteFor: covering.map((s) => ({ substitutionId: s.id, classId: s.classId, className: s.classRoom?.name ?? null, shiftId: s.shiftId, absentUser: person(s.absentUser, s.absentUserId) })),
          coveredBy: coveredBy.map((s) => ({ substitutionId: s.id, classId: s.classId, className: s.classRoom?.name ?? null, shiftId: s.shiftId, substituteUser: person(s.substituteUser, s.substituteUserId) })),
          leaveId: leave?.id ?? null,
        };
      });
      const count = (st: DayStatus) => days.filter((d) => d.status === st).length;
      return {
        user: { id: user.id, name: user.name, role: user.role, username: user.username }, days,
        totals: { workDays: count('full') + count('late') + count('substitute'), full: count('full'), late: count('late'), leave: count('leave'), absent: count('absent'), substitute: count('substitute') },
      };
    });
    return { dates, rows };
  }

  @Get('attendance') @Roles('admin', 'teacher', 'accountant')
  @ApiOperation({ summary: 'Bảng chấm công theo ngày (admin: toàn bộ GV; GV / kế toán: của mình) + ô tổng có mặt / đi muộn / nghỉ phép / cần trông thay' })
  async attendance(@CurrentUser() u: AuthUser, @Query() q: AttendanceQuery) {
    const { from, to } = this.range(q);
    const ids = u.role === 'admin' ? (q.userId ? [q.userId] : null) : [u.id];
    const { dates, rows } = await this.report(ids, from, to);
    const t = todayStr();
    const day = q.date ? d10(q.date) : t >= from && t <= to ? t : to;
    const on = (r: (typeof rows)[number]) => r.days.find((d) => d.date === day);
    const needs = u.role === 'admin' ? await this.needsFor([day]) : [];
    const sum = (st: DayStatus) => rows.reduce((s, r) => s + r.totals[st as 'late'], 0);
    return {
      from, to, dates,
      summary: {
        date: day, totalStaff: rows.length,
        present: rows.filter((r) => on(r)?.checkInAt).length,
        late: rows.filter((r) => on(r)?.status === 'late').length,
        leave: rows.filter((r) => on(r)?.status === 'leave').length,
        absent: rows.filter((r) => on(r)?.status === 'absent').length,
        needSubstitute: needs.length,
        range: { full: sum('full'), late: sum('late'), leave: sum('leave'), absent: sum('absent'), substitute: sum('substitute') },
      },
      items: rows,
    };
  }

  // ───────────────────────── leaves ─────────────────────────
  private leaveView = (l: StaffLeave) => ({ id: l.id, userId: l.userId, userName: l.user?.name ?? null, fromDate: l.fromDate, toDate: l.toDate, reason: l.reason, status: l.status,
    decidedBy: l.decidedBy, decidedAt: l.decidedAt, decisionNote: l.decisionNote, createdAt: l.createdAt });

  @Post('leaves') @Roles('admin', 'teacher', 'accountant')
  @ApiOperation({ summary: 'Xin nghỉ phép (của mình, chờ BGH duyệt). Admin có thể tạo cho người khác với userId (duyệt luôn).' })
  async requestLeave(@CurrentUser() u: AuthUser, @Body() dto: LeaveDto) {
    const from = d10(dto.fromDate), to = d10(dto.toDate);
    if (to < from) throw BadRequest('Ngày kết thúc phải ≥ ngày bắt đầu', 'INVALID_RANGE');
    if (datesBetween(from, to, 32).length > 31) throw BadRequest('Tối đa 31 ngày mỗi đơn', 'INVALID_RANGE');
    if (dto.userId && u.role !== 'admin') throw Forbidden('Chỉ BGH tạo phép cho người khác');
    const userId = dto.userId ?? u.id;
    const user = await this.staffUser(this.ds, userId);
    const byAdmin = u.role === 'admin' && userId !== u.id;
    return this.ds.transaction(async (m) => {
      const overlap = await m.getRepository(StaffLeave).findOne({ where: { userId, status: In(['pending', 'approved']), fromDate: LessThanOrEqual(to), toDate: MoreThanOrEqual(from) } });
      if (overlap) throw new AppError(409, 'LEAVE_OVERLAP', `Trùng với đơn nghỉ ${overlap.fromDate} – ${overlap.toDate} (${overlap.status})`);
      const l = await m.getRepository(StaffLeave).save({ userId, fromDate: from, toDate: to, reason: dto.reason.trim(), requestedBy: u.id,
        status: byAdmin ? 'approved' : 'pending', ...(byAdmin ? { decidedBy: u.id, decidedAt: new Date() } : {}) });
      await recordAudit(m, u, { action: byAdmin ? 'staff_leave.create_approved' : 'staff_leave.request', entityType: 'staff_leave', entityId: l.id, before: null,
        after: { userId, fromDate: from, toDate: to, status: l.status }, reason: l.reason, targetLabel: user.name });
      l.user = user;
      if (!byAdmin) {
        const admins = await m.getRepository(User).find({ where: { role: 'admin', isActive: true }, select: { id: true } });
        await this.notify.send(admins.map((a) => a.id).filter((id) => id !== u.id), { type: 'staff_leave', refId: l.id, title: `${user.name} xin nghỉ phép`,
          body: `${from === to ? from : `${from} – ${to}`}: ${l.reason}`, data: { leaveId: l.id, userId, fromDate: from, toDate: to } });
      }
      return this.leaveView(l);
    });
  }

  @Get('leaves') @Roles('admin', 'teacher', 'accountant')
  async leaves(@CurrentUser() u: AuthUser, @Query() q: LeaveQuery) {
    const qb = this.ds.getRepository(StaffLeave).createQueryBuilder('l').leftJoinAndSelect('l.user', 'u').orderBy('l.fromDate', 'DESC').addOrderBy('l.createdAt', 'DESC');
    if (u.role !== 'admin') qb.andWhere('l.user_id = :me', { me: u.id }); else if (q.userId) qb.andWhere('l.user_id = :uid', { uid: q.userId });
    if (q.status) qb.andWhere('l.status = :st', { st: q.status });
    if (q.from) qb.andWhere('l.to_date >= :f', { f: d10(q.from) });
    if (q.to) qb.andWhere('l.from_date <= :t', { t: d10(q.to) });
    return { items: (await qb.take(300).getMany()).map(this.leaveView) };
  }

  private async decide(u: AuthUser, id: string, status: 'approved' | 'rejected' | 'cancelled', note: string | null) {
    return this.ds.transaction(async (m) => {
      const l = await m.getRepository(StaffLeave).findOne({ where: { id }, relations: { user: true }, lock: { mode: 'pessimistic_write', tables: ['staff_leaves'] } });
      if (!l) throw NotFound('Không tìm thấy đơn nghỉ');
      if (status === 'cancelled') {
        if (u.role !== 'admin' && l.userId !== u.id) throw Forbidden('Chỉ người xin nghỉ hoặc BGH được huỷ đơn');
        if (u.role !== 'admin' && l.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', 'Đơn đã được xử lý; liên hệ BGH để huỷ');
        if (l.status === 'cancelled' || l.status === 'rejected') throw new AppError(409, 'ALREADY_DECIDED', 'Đơn đã kết thúc');
      } else if (l.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', `Đơn đã ${l.status === 'approved' ? 'được duyệt' : l.status === 'rejected' ? 'bị từ chối' : 'bị huỷ'}`);
      const before = { status: l.status };
      Object.assign(l, { status, decidedBy: u.id, decidedAt: new Date(), decisionNote: note });
      await m.getRepository(StaffLeave).save(l);
      await recordAudit(m, u, { action: `staff_leave.${status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'cancel'}`, entityType: 'staff_leave', entityId: l.id,
        before, after: { status, fromDate: l.fromDate, toDate: l.toDate }, reason: note, targetLabel: l.user?.name ?? null });
      if (status !== 'cancelled' && l.userId !== u.id)
        await this.notify.send([l.userId], { type: 'staff_leave_decision', refId: l.id, title: status === 'approved' ? 'Đơn nghỉ phép đã được duyệt' : 'Đơn nghỉ phép bị từ chối',
          body: `${l.fromDate === l.toDate ? l.fromDate : `${l.fromDate} – ${l.toDate}`}${note ? ` · ${note}` : ''}`, data: { leaveId: l.id, status } });
      return this.leaveView(l);
    });
  }

  @Post('leaves/:id/approve') @Roles('admin') @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto) { return this.decide(u, id, 'approved', dto.note?.trim() || null); }

  @Post('leaves/:id/reject') @Roles('admin') @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto) {
    if (!dto.note?.trim()) throw BadRequest('Bắt buộc ghi lý do từ chối', 'NOTE_REQUIRED');
    return this.decide(u, id, 'rejected', dto.note.trim());
  }

  @Post('leaves/:id/cancel') @Roles('admin', 'teacher', 'accountant') @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto) { return this.decide(u, id, 'cancelled', dto.note?.trim() || null); }

  // ───────────────────────── substitutions (trông thay) ─────────────────────────
  private subsQuery(q: { from: string; to: string }) {
    return this.ds.getRepository(StaffSubstitution).createQueryBuilder('s')
      .leftJoinAndSelect('s.shift', 'sh').leftJoinAndSelect('s.classRoom', 'c').leftJoinAndSelect('s.absentUser', 'au').leftJoinAndSelect('s.substituteUser', 'su')
      .where('s.date BETWEEN :from AND :to', q).orderBy('s.date', 'ASC').addOrderBy('sh.start_time', 'ASC');
  }
  private subView = (s: StaffSubstitution) => ({
    id: s.id, date: s.date, shift: shiftView(s.shift), class: { id: s.classId, name: s.classRoom?.name ?? null },
    absentTeacher: person(s.absentUser, s.absentUserId), substituteTeacher: person(s.substituteUser, s.substituteUserId), reason: s.reason, note: s.note, createdAt: s.createdAt,
  });

  /** Classes whose every assigned teacher for a shift is unavailable (approved leave, or absent after the shift started) and that have no substitute yet. */
  private async needsFor(dates: string[]) {
    if (!dates.length) return [];
    const asg = await this.ds.getRepository(StaffShiftAssignment).find({ where: { date: In(dates), classId: Not(IsNull()) }, relations: { shift: true, classRoom: true, user: true } });
    const withClass = asg;
    if (!withClass.length) return [];
    const from = dates.slice().sort()[0], to = dates.slice().sort().pop()!;
    const lv = await this.ds.getRepository(StaffLeave).find({ where: { status: 'approved', fromDate: LessThanOrEqual(to), toDate: MoreThanOrEqual(from) } });
    const ci = await this.ds.getRepository(StaffCheckin).find({ where: { date: In(dates) } });
    const subs = await this.subsQuery({ from, to }).getMany();
    const now = new Date();
    const unavailable = (a: StaffShiftAssignment): { reason: 'leave' | 'absent'; leaveId?: string } | null => {
      const l = lv.find((x) => x.userId === a.userId && x.fromDate <= a.date && x.toDate >= a.date);
      if (l) return { reason: 'leave', leaveId: l.id };
      const c = ci.find((x) => x.userId === a.userId && x.date === a.date);
      if (!c?.checkInAt && now > new Date(vnAt(a.date, a.shift.startTime).getTime() + a.shift.lateGraceMinutes * 60000)) return { reason: 'absent' };
      return null;
    };
    const slots = new Map<string, StaffShiftAssignment[]>();
    for (const a of withClass) { const k = `${a.date}|${a.shiftId}|${a.classId}`; slots.set(k, [...(slots.get(k) ?? []), a]); }
    const out: any[] = [];
    for (const [, list] of slots) {
      const a0 = list[0];
      if (subs.some((s) => s.date === a0.date && s.shiftId === a0.shiftId && s.classId === a0.classId)) continue;
      const st = list.map(unavailable);
      if (st.some((x) => !x)) continue;
      const [{ n }] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM children WHERE class_id = $1 AND status = 'active'`, [a0.classId]);
      out.push({
        date: a0.date, shift: shiftView(a0.shift), class: { id: a0.classId, name: a0.classRoom?.name ?? null, children: Number(n) },
        absentTeachers: list.map((a, i) => ({ ...person(a.user, a.userId), reason: st[i]!.reason, leaveId: st[i]!.leaveId ?? null })),
        suggestions: await this.suggest(a0.date, a0.shift, [...list.map((a) => a.userId)]),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.shift.startTime.localeCompare(b.shift.startTime) || String(a.class.name).localeCompare(String(b.class.name)));
  }

  /** Free teachers for date + shift: active teachers, not on approved leave, no overlapping shift, not already substituting at that time. Fully free first. */
  private async suggest(date: string, shift: StaffShift, exclude: string[]) {
    const teachers = await this.ds.getRepository(User).find({ where: { role: 'teacher', isActive: true } });
    const asg = await this.ds.getRepository(StaffShiftAssignment).find({ where: { date }, relations: { shift: true } });
    const subs = await this.subsQuery({ from: date, to: date }).getMany();
    const lv = await this.ds.getRepository(StaffLeave).find({ where: { status: 'approved', fromDate: LessThanOrEqual(date), toDate: MoreThanOrEqual(date) } });
    const overlaps = (s: StaffShift) => minutesOf(s.startTime) < minutesOf(shift.endTime) && minutesOf(shift.startTime) < minutesOf(s.endTime);
    return teachers.filter((t) => !exclude.includes(t.id) && !lv.some((l) => l.userId === t.id))
      .map((t) => {
        const own = asg.filter((a) => a.userId === t.id);
        const busy = own.some((a) => overlaps(a.shift)) || subs.some((s) => s.substituteUserId === t.id && overlaps(s.shift));
        return { t, own, busy };
      })
      .filter((x) => !x.busy)
      .sort((a, b) => a.own.length - b.own.length || a.t.name.localeCompare(b.t.name, 'vi'))
      .slice(0, 5)
      .map(({ t, own }) => ({ userId: t.id, name: t.name, freeNote: own.length ? `Rảnh ${shift.name.toLowerCase()} (có ${own.map((a) => a.shift.name.toLowerCase()).join(', ')})` : 'Rảnh cả ngày' }));
  }

  @Get('substitutions/needs') @Roles('admin')
  @ApiOperation({ summary: 'Lớp thiếu GV cần trông thay (GV nghỉ phép / chưa vào ca sau giờ bắt đầu) + gợi ý GV rảnh' })
  async needs(@Query() q: NeedsQuery) {
    const t = todayStr();
    const { from, to } = q.from || q.to ? this.range({ from: q.from ?? q.to, to: q.to ?? q.from }, 31) : { from: q.date ? d10(q.date) : t, to: q.date ? d10(q.date) : t };
    return { from, to, items: await this.needsFor(datesBetween(from, to, 31)) };
  }

  @Get('substitutions') @Roles('admin', 'teacher', 'accountant')
  @ApiOperation({ summary: 'Lịch trông thay (admin: tất cả; GV: mình trông thay / được trông thay / lớp của mình). Mặc định tuần này.' })
  async substitutions(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) {
    const { from, to } = this.range(q);
    const qb = this.subsQuery({ from, to });
    if (u.role !== 'admin') qb.andWhere('(s.substitute_user_id = :me OR s.absent_user_id = :me OR s.class_id = ANY(:cls))', { me: u.id, cls: u.classIds.length ? u.classIds : ['00000000-0000-0000-0000-000000000000'] });
    else if (q.userId) qb.andWhere('(s.substitute_user_id = :uid OR s.absent_user_id = :uid)', { uid: q.userId });
    if (q.classId) qb.andWhere('s.class_id = :cid', { cid: q.classId });
    return { from, to, items: (await qb.getMany()).map(this.subView) };
  }

  @Post('substitutions') @Roles('admin')
  @ApiOperation({ summary: 'Phân trông thay: GV trông lớp cho ngày + ca. 409 SLOT_TAKEN / SUBSTITUTE_BUSY / SUBSTITUTE_ON_LEAVE.' })
  async substitute(@CurrentUser() u: AuthUser, @Body() dto: SubstitutionDto, @Req() req: Request) {
    const date = d10(dto.date);
    if (date < addDays(todayStr(), -31)) throw BadRequest('Chỉ ghi nhận trông thay trong vòng 31 ngày trước trở đi', 'INVALID_DATE');
    const shift = await this.activeShift(dto.shiftId);
    const cls = await this.ds.getRepository(ClassRoom).findOneBy({ id: dto.classId });
    if (!cls) throw NotFound('Không tìm thấy lớp');
    const sub = await this.staffUser(this.ds, dto.substituteUserId, ['teacher', 'admin']);
    let absentUserId = dto.absentUserId ?? null;
    if (!absentUserId) absentUserId = (await this.ds.getRepository(StaffShiftAssignment).findOne({ where: { date, shiftId: shift.id, classId: cls.id } }))?.userId ?? null;
    if (absentUserId === sub.id) throw BadRequest('Người trông thay trùng với GV vắng', 'VALIDATION_ERROR');
    const saved = await this.ds.transaction(async (m) => {
      if (await m.getRepository(StaffSubstitution).exist({ where: { date, shiftId: shift.id, classId: cls.id } })) throw new AppError(409, 'SLOT_TAKEN', 'Lớp này đã có người trông thay trong ca');
      if (await m.getRepository(StaffLeave).exist({ where: { userId: sub.id, status: 'approved', fromDate: LessThanOrEqual(date), toDate: MoreThanOrEqual(date) } }))
        throw new AppError(409, 'SUBSTITUTE_ON_LEAVE', `${sub.name} đang nghỉ phép ngày này`);
      const overlaps = (s: StaffShift) => minutesOf(s.startTime) < minutesOf(shift.endTime) && minutesOf(shift.startTime) < minutesOf(s.endTime);
      const otherSubs = await m.getRepository(StaffSubstitution).find({ where: { date, substituteUserId: sub.id }, relations: { shift: true } });
      if (otherSubs.some((s) => overlaps(s.shift))) throw new AppError(409, 'SUBSTITUTE_BUSY', `${sub.name} đã trông thay lớp khác trong ca này`);
      const own = await m.getRepository(StaffShiftAssignment).find({ where: { date, userId: sub.id }, relations: { shift: true } });
      if (!dto.force && own.some((a) => overlaps(a.shift))) throw new AppError(409, 'SUBSTITUTE_BUSY', `${sub.name} có ca trùng giờ; gửi force=true nếu vẫn phân`);
      const s = await m.getRepository(StaffSubstitution).save({ date, shiftId: shift.id, classId: cls.id, absentUserId, substituteUserId: sub.id,
        reason: dto.reason?.trim() || null, note: dto.note?.trim() || null, createdBy: u.id });
      await recordAudit(m, u, { action: 'substitution.assign', entityType: 'staff_substitution', entityId: s.id, before: null,
        after: { date, shiftId: shift.id, shiftName: shift.name, classId: cls.id, className: cls.name, absentUserId, substituteUserId: sub.id }, reason: s.reason, ip: req.ip ?? null,
        targetLabel: `${cls.name} · ${date} · ${shift.name}` });
      return s;
    });
    const full = (await this.subsQuery({ from: date, to: date }).andWhere('s.id = :id', { id: saved.id }).getOne())!;
    await this.notify.send([sub.id], { type: 'substitution', refId: saved.id, title: `Trông thay lớp ${cls.name}`,
      body: `${date} · ${shift.name} ${shift.startTime}–${shift.endTime}${full.absentUser ? ` · thay ${full.absentUser.name}` : ''}`, data: { substitutionId: saved.id, date, classId: cls.id, shiftId: shift.id } });
    return this.subView(full);
  }

  @Delete('substitutions/:id') @Roles('admin') @HttpCode(204)
  async unsubstitute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.ds.transaction(async (m) => {
      const s = await m.getRepository(StaffSubstitution).findOne({ where: { id }, relations: { classRoom: true, shift: true } });
      if (!s) throw NotFound('Không tìm thấy lịch trông thay');
      await m.getRepository(StaffSubstitution).delete(id);
      await recordAudit(m, u, { action: 'substitution.remove', entityType: 'staff_substitution', entityId: id,
        before: { date: s.date, shiftId: s.shiftId, classId: s.classId, absentUserId: s.absentUserId, substituteUserId: s.substituteUserId }, after: null,
        targetLabel: `${s.classRoom?.name ?? ''} · ${s.date} · ${s.shift?.name ?? ''}` });
    });
  }
}
