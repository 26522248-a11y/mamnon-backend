import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DataSource, In } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth';
import { addDays, dayDiff, todayStr, viDayLabel } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { absenceCutoff, latestPickupTime } from '../common/school';
import { ABSENCE_REASONS, Absence, AbsenceDay, AbsenceEvent, AbsenceReason, Attendance, AttendanceHistory } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';
import { AbsencesService, REASON_LABEL, confirmedHolidays, isWeekend, refundEligibleFor } from './absences.service';

export const MAX_ABSENCE_DAYS = 31;

export class CreateAbsenceDto {
  @ApiProperty({ example: '2026-10-12' }) @IsDateString() from!: string;
  @ApiPropertyOptional({ example: '2026-10-13', description: 'Mặc định = from' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ enum: ABSENCE_REASONS, description: 'U4: không bắt buộc, mặc định other' }) @IsOptional() @IsIn(ABSENCE_REASONS) reason?: AbsenceReason;
  @ApiPropertyOptional({ example: 'Bé sốt nhẹ' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class AbsenceListQuery {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}
export class CancelAbsenceDto {
  @ApiPropertyOptional({ type: [String], description: 'Chỉ hủy các ngày này (mặc định: mọi ngày còn hủy được)' })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_ABSENCE_DAYS) @IsDateString({}, { each: true }) dates?: string[];
}

@ApiTags('absences')
@ApiBearerAuth()
@Controller()
export class AbsencesController {
  constructor(private ds: DataSource, private access: AccessService, private svc: AbsencesService, private notify: NotificationsService) {}

  /** FE fallback config. */
  @Public() @Get('absences/config')
  config() { return { cutoff: absenceCutoff(), latestPickup: latestPickupTime() }; }

  @Post('children/:id/absences') @Roles('parent', 'admin')
  async create(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAbsenceDto) {
    dto.reason = dto.reason ?? 'other'; // U4: one-tap report, reason optional
    const child = await this.access.getChildOr404(id);
    if (u.role === 'parent' && !u.childIds.includes(id)) throw Forbidden('Không có quyền với trẻ này');
    if (child.status === 'withdrawn') throw BadRequest('Trẻ đã nghỉ học', 'CHILD_WITHDRAWN');
    const today = todayStr();
    const from = dto.from, to = dto.to ?? dto.from;
    if (from < today) throw BadRequest('Không thể báo vắng cho ngày đã qua', 'DATE_IN_PAST');
    if (to < from) throw BadRequest('Ngày kết thúc phải sau ngày bắt đầu', 'INVALID_RANGE');
    if (dayDiff(to, from) + 1 > MAX_ABSENCE_DAYS) throw BadRequest(`Tối đa ${MAX_ABSENCE_DAYS} ngày mỗi lần báo`, 'RANGE_TOO_LONG');
    if (dayDiff(from, today) > 120) throw BadRequest('Chỉ báo vắng trong vòng 120 ngày tới', 'DATE_TOO_FAR');

    const now = new Date();
    const result = await this.ds.transaction(async (m) => {
      const holidays = await confirmedHolidays(m, from, to);
      const att = await m.createQueryBuilder(Attendance, 'a').setLock('pessimistic_write')
        .where('a.child_id = :id AND a.date BETWEEN :from AND :to', { id, from, to }).getMany();
      const attBy = new Map(att.map((a) => [a.date, a]));
      const skipped: { date: string; reason: string }[] = [];
      const dates: string[] = [];
      for (const d of AbsencesService.range(from, to)) {
        if (isWeekend(d)) skipped.push({ date: d, reason: 'WEEKEND' });
        else if (holidays.has(d)) skipped.push({ date: d, reason: 'HOLIDAY' });
        else if (attBy.get(d) && attBy.get(d)!.status !== 'absent') skipped.push({ date: d, reason: 'ALREADY_PRESENT' });
        else dates.push(d);
      }
      if (!dates.length) throw new AppError(400, 'NO_SCHOOL_DAYS', 'Không có ngày học nào trong khoảng đã chọn', { skippedDates: skipped });
      const overlap = await m.createQueryBuilder(AbsenceDay, 'd').where('d.child_id = :id AND d.date IN (:...dates) AND d.cancelled_at IS NULL', { id, dates }).getMany();
      if (overlap.length) throw new AppError(409, 'ABSENCE_OVERLAP', 'Đã có báo vắng cho ngày này', { dates: overlap.map((d) => d.date).sort(), absenceIds: [...new Set(overlap.map((d) => d.absenceId))] });

      const note = dto.note?.trim() || null;
      const abs = await m.save(Absence, m.create(Absence, { childId: id, classId: child.classId, from, to, reason: dto.reason!, note, createdBy: u.id }));
      for (const d of dates) {
        const refundEligible = refundEligibleFor(d, today, now);
        await m.save(AbsenceDay, m.create(AbsenceDay, { absenceId: abs.id, childId: id, date: d, refundEligible }));
        if (!child.classId) continue;
        const attNote = `PH báo vắng: ${REASON_LABEL[dto.reason!]}${note ? ` – ${note}` : ''}`.slice(0, 500);
        const old = attBy.get(d);
        if (!old) {
          const a = await m.save(Attendance, m.create(Attendance, { childId: id, classId: child.classId, date: d, status: 'absent', note: attNote,
            notifiedInAdvance: refundEligible, absenceReason: dto.reason!, absenceId: abs.id, recordedBy: u.id }));
          await m.save(AttendanceHistory, m.create(AttendanceHistory, { attendanceId: a.id, action: 'create', oldStatus: null, oldNote: null, oldNotified: null,
            newStatus: 'absent', newNote: attNote, newNotified: refundEligible, changedBy: u.id }));
        } else {
          await m.update(Attendance, old.id, { note: attNote, notifiedInAdvance: refundEligible, absenceReason: dto.reason!, absenceId: abs.id, recordedBy: u.id });
          await m.save(AttendanceHistory, m.create(AttendanceHistory, { attendanceId: old.id, action: 'update', oldStatus: old.status, oldNote: old.note,
            oldNotified: old.notifiedInAdvance, newStatus: 'absent', newNote: attNote, newNotified: refundEligible, changedBy: u.id }));
        }
      }
      await m.save(AbsenceEvent, m.create(AbsenceEvent, { absenceId: abs.id, action: 'created', dates, actorId: u.id }));
      return { abs, dates, skipped };
    }).catch((e) => {
      if (e?.driverError?.code === '23505') throw new AppError(409, 'ABSENCE_OVERLAP', 'Đã có báo vắng cho ngày này');
      throw e;
    });

    const [view] = await this.svc.views(u, [Object.assign(result.abs, { skippedDates: result.skipped })]);
    const span = result.dates.length === 1 ? viDayLabel(result.dates[0]) : `${result.dates.length} ngày (${viDayLabel(result.dates[0])} → ${viDayLabel(result.dates[result.dates.length - 1])})`;
    const msg = { title: `Báo vắng: ${child.fullName}${child.classRoom ? ` (${child.classRoom.name})` : ''} – ${span}`,
      body: `${REASON_LABEL[dto.reason!]}${dto.note ? `: ${dto.note}` : ''}`, data: { absenceId: result.abs.id, childId: id, dates: result.dates }, refId: result.abs.id };
    await this.notify.send(await this.svc.classTeacherIds(child.classId), { type: 'absence_report', ...msg });
    if (result.dates.includes(todayStr())) await this.notify.send(await this.svc.kitchenIds(), { type: 'kitchen_change', ...msg });
    return view;
  }

  private async readable(u: AuthUser, childId: string) {
    const c = await this.access.getChildOr404(childId);
    const ok = u.role === 'admin' || (u.role === 'parent' && u.childIds.includes(childId)) || (u.role === 'teacher' && !!c.classId && u.classIds.includes(c.classId));
    if (!ok) throw Forbidden('Không có quyền xem trẻ này');
    return c;
  }

  @Get('children/:id/absences') @Roles('parent', 'admin', 'teacher')
  async list(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: AbsenceListQuery) {
    await this.readable(u, id);
    const from = q.from ?? addDays(todayStr(), -30);
    const qb = this.ds.getRepository(Absence).createQueryBuilder('a').where('a.child_id = :id AND a.to_date >= :from', { id, from });
    if (q.to) qb.andWhere('a.from_date <= :to', { to: q.to });
    const rows = await qb.orderBy('a.created_at', 'DESC').getMany();
    return { items: await this.svc.views(u, rows) };
  }

  private async getAbsence(u: AuthUser, id: string) {
    const a = await this.ds.getRepository(Absence).findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy báo vắng');
    await this.readable(u, a.childId);
    return a;
  }

  @Get('absences/:id') @Roles('parent', 'admin', 'teacher')
  async one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.svc.views(u, [await this.getAbsence(u, id)]))[0];
  }

  @Delete('absences/:id') @Roles('parent', 'admin') @HttpCode(200)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelAbsenceDto, @Query('dates') qDates?: string | string[]) {
    const a = await this.getAbsence(u, id);
    const wanted = dto?.dates ?? (qDates ? (Array.isArray(qDates) ? qDates : qDates.split(',')) : undefined);
    const done = await this.ds.transaction(async (m) => {
      const days = await m.createQueryBuilder(AbsenceDay, 'd').setLock('pessimistic_write').where('d.absence_id = :id', { id }).getMany();
      const allowed = this.svc.cancellableDates(u, days);
      const target = wanted ? [...new Set(wanted)] : allowed;
      const notAllowed = target.filter((d) => !allowed.includes(d));
      if (!target.length || notAllowed.length)
        throw new AppError(409, 'CANCEL_AFTER_CUTOFF', `Đã quá ${absenceCutoff()} hoặc ngày đã qua – không thể hủy báo vắng; vui lòng liên hệ giáo viên`,
          { dates: notAllowed.length ? notAllowed : days.filter((d) => !d.cancelledAt).map((d) => d.date), cutoff: absenceCutoff() });
      await this.svc.cancelDays(m, a, target, u.id);
      return target.sort();
    });
    const fresh = await this.ds.getRepository(Absence).findOneByOrFail({ id });
    const child = await this.access.getChildOr404(a.childId);
    const msg = { title: `Hủy báo vắng: ${child.fullName}${child.classRoom ? ` (${child.classRoom.name})` : ''} – ${done.map(viDayLabel).join(', ')}`,
      data: { absenceId: id, childId: a.childId, dates: done }, refId: id };
    await this.notify.send(await this.svc.classTeacherIds(child.classId), { type: 'absence_cancelled', ...msg });
    if (done.includes(todayStr())) await this.notify.send(await this.svc.kitchenIds(), { type: 'kitchen_change', ...msg });
    return (await this.svc.views(u, [fresh]))[0];
  }
}
