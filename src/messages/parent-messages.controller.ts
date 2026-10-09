import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Allow, IsDateString, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Response } from 'express';
import { DataSource, In, IsNull } from 'typeorm';
import { AbsencesService, confirmedHolidays, isWeekend } from '../absences/absences.service';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { addDays, todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { latestPickupTime, medicineLateMinutes, schoolOpenTime, vnNowHM } from '../common/school';
import { imageUploadOptions, saveImage, sendImage } from '../common/upload';
import { Absence, Child, LatePickup, Medicine, MedicineDose, User } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const addMinutes = (hm: string, n: number) => { const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) + n; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
/** Dose is late: not given and now (VN) is past time + MEDICINE_LATE_MINUTES on its day (or the day is over). */
export const doseLate = (date: string, time: string, givenAt: Date | null, today = todayStr(), nowHM = vnNowHM()) =>
  !givenAt && (date < today || (date === today && nowHM >= addMinutes(time, medicineLateMinutes())));

export class CreateMedicineDto {
  @ApiPropertyOptional({ example: '2026-10-12', description: 'Mặc định hôm nay' }) @IsOptional() @IsDateString() date?: string;
  @ApiProperty({ example: 'Siro ho Prospan' }) @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @ApiProperty({ example: '5 ml' }) @IsString() @IsNotEmpty() @MaxLength(120) dose!: string;
  @ApiPropertyOptional({ description: 'JSON [{time:"11:30", label?}] (multipart: chuỗi JSON) – hoặc dùng times' }) @Allow() doses?: unknown;
  @ApiPropertyOptional({ description: 'Danh sách giờ HH:MM (lặp lại field hoặc phân tách bằng dấu phẩy)' }) @Allow() times?: unknown;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class GivenDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class DateQ {
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}
export class RangeQ {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}
export class CreateLatePickupDto {
  @ApiProperty({ example: '2026-10-12' }) @IsDateString() date!: string;
  @ApiProperty({ example: '17:30' }) @Matches(HM, { message: 'time phải dạng HH:MM' }) time!: string;
  @ApiPropertyOptional({ example: 'Bà ngoại' }) @IsOptional() @IsString() @MaxLength(120) pickerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

function parseDoses(dto: CreateMedicineDto): { time: string; label: string | null }[] {
  let raw: any = dto.doses ?? dto.times;
  if (raw === undefined || raw === null || raw === '') throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu giờ uống thuốc (doses)', { details: ['doses is required'] });
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) { try { raw = JSON.parse(t); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'doses không phải JSON hợp lệ'); } }
    else raw = t.split(',');
  }
  if (!Array.isArray(raw)) raw = [raw];
  const out = raw.map((x: any) => (typeof x === 'string' ? { time: x.trim(), label: null } : { time: String(x?.time ?? '').trim(), label: x?.label ? String(x.label).slice(0, 60) : null }));
  if (!out.length || out.length > 6) throw new AppError(400, 'VALIDATION_ERROR', 'Cần 1–6 lần uống');
  if (out.some((d: any) => !HM.test(d.time))) throw new AppError(400, 'VALIDATION_ERROR', 'Giờ uống phải dạng HH:MM');
  if (new Set(out.map((d: any) => d.time)).size !== out.length) throw new AppError(400, 'VALIDATION_ERROR', 'Trùng giờ uống');
  return out.sort((a: any, b: any) => a.time.localeCompare(b.time));
}

/**
 * Round 2 parent messages: medicine instructions (+ dose given), late pickup requests, class message feed.
 * Parent: own children; teacher: own classes; admin: all.
 */
@ApiTags('parent-messages')
@ApiBearerAuth()
@Controller()
export class ParentMessagesController {
  constructor(private ds: DataSource, private access: AccessService, private absences: AbsencesService, private notify: NotificationsService) {}

  private async childFor(u: AuthUser, id: string, write: boolean) {
    const c = await this.access.getChildOr404(id);
    const ok = u.role === 'admin' || (u.role === 'parent' && u.childIds.includes(id)) || (!write && u.role === 'teacher' && !!c.classId && u.classIds.includes(c.classId))
      || (!write && await this.substituteToday(u, c.classId));
    if (!ok) throw Forbidden('Không có quyền với trẻ này');
    return c;
  }
  /** G8: a teacher covering the class today (staff_substitutions) acts as class teacher for medicines / parent messages, today only. */
  private async substituteToday(u: AuthUser, classId: string | null) {
    if (u.role !== 'teacher' || !classId) return false;
    const [{ n }] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM staff_substitutions WHERE substitute_user_id = $1 AND class_id = $2 AND date = $3`, [u.id, classId, todayStr()]);
    return Number(n) > 0;
  }
  private async assertSchoolDay(date: string) {
    if (isWeekend(date)) throw BadRequest('Ngày nghỉ cuối tuần', 'NOT_SCHOOL_DAY');
    const h = (await confirmedHolidays(this.ds.manager, date, date)).get(date);
    if (h) throw new AppError(400, 'SCHOOL_HOLIDAY', `Trường nghỉ (${h.name})`, { holiday: { id: h.id, name: h.name } });
  }
  private async names(ids: (string | null)[]) {
    const u = [...new Set(ids.filter(Boolean) as string[])];
    const rows = u.length ? await this.ds.getRepository(User).find({ where: { id: In(u) }, select: { id: true, name: true } }) : [];
    return new Map(rows.map((x) => [x.id, x.name]));
  }
  private async kids(ids: string[]) {
    const rows = ids.length ? await this.ds.getRepository(Child).find({ where: { id: In([...new Set(ids)]) }, relations: { classRoom: true } }) : [];
    return new Map(rows.map((c) => [c.id, c]));
  }

  // ───── medicines ─────
  async medicineViews(rows: Medicine[]) {
    if (!rows.length) return [];
    const doses = await this.ds.getRepository(MedicineDose).find({ where: { medicineId: In(rows.map((r) => r.id)) }, order: { time: 'ASC' } });
    const n = await this.names([...rows.map((r) => r.createdBy), ...doses.map((d) => d.givenBy)]);
    const k = await this.kids(rows.map((r) => r.childId));
    const today = todayStr(), now = vnNowHM();
    return rows.map((m) => ({
      id: m.id, childId: m.childId, childName: k.get(m.childId)?.fullName ?? null, classId: m.classId, className: k.get(m.childId)?.classRoom?.name ?? null,
      date: m.date, name: m.name, dose: m.dose, note: m.note, photoUrl: m.photoUrl ? `/api/v1/medicines/${m.id}/photo` : null,
      doses: doses.filter((d) => d.medicineId === m.id).map((d) => ({
        id: d.id, time: d.time, label: d.label, givenAt: d.givenAt, givenBy: d.givenBy, givenByName: d.givenBy ? n.get(d.givenBy) ?? null : null,
        givenNote: d.givenNote, late: !m.cancelledAt && doseLate(m.date, d.time, d.givenAt, today, now),
      })),
      status: m.cancelledAt ? 'cancelled' : 'active', createdBy: m.createdBy, createdByName: m.createdBy ? n.get(m.createdBy) ?? null : null,
      createdAt: m.createdAt, cancelledAt: m.cancelledAt,
    }));
  }

  /** P9: upcoming substitute teachers for the child's class (today + future, live rows only; a deleted substitution or a
   *  cancelled/rejected leave drops out). Parent card: "Thứ Hai cô Mai trông con". */
  @Get('children/:id/substitutions') @Roles('parent', 'admin', 'teacher')
  async childSubstitutions(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.childFor(u, id, false);
    if (!c.classId) return { items: [] };
    const rows = await this.ds.query(`SELECT s.id, s.date::text AS date, s.session, s.class_id, cl.name AS class_name, su.name AS substitute_name
      FROM staff_substitutions s JOIN users su ON su.id = s.substitute_user_id JOIN classes cl ON cl.id = s.class_id
      LEFT JOIN staff_leaves l ON l.id = s.leave_id
      WHERE s.class_id = $1 AND s.date >= $2 AND (s.leave_id IS NULL OR l.status = 'approved')
      ORDER BY s.date, s.session LIMIT 50`, [c.classId, todayStr()]);
    return { items: rows.map((r: any) => ({ substitutionId: r.id, date: r.date, session: r.session ?? 'full', classId: r.class_id, className: r.class_name,
      substituteName: r.substitute_name, today: r.date === todayStr() })) };
  }

  @Post('children/:id/medicines') @Roles('parent', 'admin')
  @UseInterceptors(FileInterceptor('photo', imageUploadOptions)) @ApiConsumes('multipart/form-data', 'application/json')
  async createMedicine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateMedicineDto, @UploadedFile() photo?: Express.Multer.File) {
    const child = await this.childFor(u, id, true);
    if (child.status === 'withdrawn') throw BadRequest('Trẻ đã nghỉ học', 'CHILD_WITHDRAWN');
    const date = dto.date ?? todayStr();
    if (date < todayStr()) throw BadRequest('Không thể dặn thuốc cho ngày đã qua', 'DATE_IN_PAST');
    if (date > addDays(todayStr(), 30)) throw BadRequest('Chỉ dặn thuốc trong 30 ngày tới', 'DATE_TOO_FAR');
    const doses = parseDoses(dto);
    await this.assertSchoolDay(date);
    const photoUrl = photo ? await saveImage(photo) : null;
    const med = await this.ds.transaction(async (m) => {
      const med = await m.save(Medicine, m.create(Medicine, { childId: id, classId: child.classId, date, name: dto.name.trim(), dose: dto.dose.trim(),
        note: dto.note?.trim() || null, photoUrl, createdBy: u.id }));
      await m.save(MedicineDose, doses.map((d) => m.create(MedicineDose, { medicineId: med.id, time: d.time, label: d.label })));
      return med;
    });
    await this.notify.send(await this.absences.classTeacherIds(child.classId), {
      type: 'medicine_request', title: `Dặn thuốc: ${child.fullName}${child.classRoom ? ` (${child.classRoom.name})` : ''} – ${date}`,
      body: `${med.name}, ${med.dose} lúc ${doses.map((d) => d.time).join(', ')}`, data: { medicineId: med.id, childId: id, date }, refId: med.id,
    });
    return (await this.medicineViews([med]))[0];
  }

  @Get('children/:id/medicines') @Roles('parent', 'admin', 'teacher')
  async listMedicines(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: DateQ & RangeQ) {
    await this.childFor(u, id, false);
    const qb = this.ds.getRepository(Medicine).createQueryBuilder('m').where('m.child_id = :id', { id });
    if ((q as any).from || (q as any).to) {
      if ((q as any).from) qb.andWhere('m.date >= :from', { from: (q as any).from });
      if ((q as any).to) qb.andWhere('m.date <= :to', { to: (q as any).to });
    } else qb.andWhere('m.date = :d', { d: q.date ?? todayStr() });
    return { items: await this.medicineViews(await qb.orderBy('m.date', 'DESC').addOrderBy('m.created_at', 'ASC').getMany()) };
  }

  private async medicineFor(u: AuthUser, id: string, write: boolean) {
    const m = await this.ds.getRepository(Medicine).findOne({ where: { id } });
    if (!m) throw NotFound('Không tìm thấy dặn thuốc');
    await this.childFor(u, m.childId, write);
    return m;
  }

  @Get('medicines/:id/photo') @Roles('parent', 'admin', 'teacher')
  async medicinePhoto(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendImage(res, (await this.medicineFor(u, id, false)).photoUrl);
  }

  @Delete('medicines/:id') @Roles('parent', 'admin') @HttpCode(200)
  async cancelMedicine(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const med = await this.medicineFor(u, id, true);
    if (med.cancelledAt) return (await this.medicineViews([med]))[0];
    const given = await this.ds.getRepository(MedicineDose).count({ where: { medicineId: id, givenAt: IsNull() as any } });
    const total = await this.ds.getRepository(MedicineDose).count({ where: { medicineId: id } });
    if (given !== total) throw new AppError(409, 'DOSE_ALREADY_GIVEN', 'Đã cho bé uống ít nhất 1 lần – không thể hủy');
    await this.ds.getRepository(Medicine).update(id, { cancelledAt: new Date(), cancelledBy: u.id });
    const child = await this.access.getChildOr404(med.childId);
    await this.notify.send(await this.absences.classTeacherIds(child.classId), {
      type: 'medicine_cancelled', title: `Hủy dặn thuốc: ${child.fullName} – ${med.name} (${med.date})`, data: { medicineId: id, childId: med.childId }, refId: id });
    return (await this.medicineViews([await this.ds.getRepository(Medicine).findOneByOrFail({ id })]))[0];
  }

  @Post('medicine-doses/:id/given') @Roles('teacher', 'admin') @HttpCode(200)
  async doseGiven(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GivenDto) {
    const dose = await this.ds.getRepository(MedicineDose).findOne({ where: { id }, relations: { medicine: true } });
    if (!dose) throw NotFound('Không tìm thấy lần uống thuốc');
    const med = dose.medicine;
    const child = await this.access.getChildOr404(med.childId);
    const covering = !this.access.canOperateClass(u, child.classId) && await this.substituteToday(u, child.classId);
    if (!this.access.canOperateClass(u, child.classId) && !covering) throw Forbidden('Không có quyền với lớp này');
    if (med.cancelledAt) throw new AppError(409, 'MEDICINE_CANCELLED', 'Phụ huynh đã hủy dặn thuốc này');
    if (med.date !== todayStr()) throw BadRequest('Chỉ đánh dấu cho bé uống trong ngày dặn thuốc', 'NOT_TODAY');
    const now = new Date();
    const r = await this.ds.createQueryBuilder().update(MedicineDose).set({ givenAt: now, givenBy: u.id, givenNote: dto.note?.trim() || null })
      .where('id = :id AND given_at IS NULL', { id }).execute();
    if (!r.affected) {
      const cur = await this.ds.getRepository(MedicineDose).findOneByOrFail({ id });
      const n = await this.names([cur.givenBy]);
      throw new AppError(409, 'ALREADY_GIVEN', `Đã đánh dấu cho uống lúc ${cur.givenAt ? vnNowHM(cur.givenAt) : ''} (${cur.givenBy ? n.get(cur.givenBy) : ''})`,
        { givenAt: cur.givenAt, givenBy: cur.givenBy, givenByName: cur.givenBy ? n.get(cur.givenBy) ?? null : null });
    }
    await this.notify.send(await this.notify.parentIdsOfChildren([med.childId]), {
      type: 'medicine_given', title: `Bé ${child.fullName.split(' ').pop()} đã được cho uống thuốc lúc ${vnNowHM(now)}`,
      body: `${med.name}, ${med.dose}${dose.label ? ` – ${dose.label}` : ''} · ${u.name}${covering ? ' (cô trông thay)' : ''}`, data: { medicineId: med.id, doseId: id, childId: med.childId, givenAt: now }, refId: med.id,
    });
    return (await this.medicineViews([med]))[0];
  }

  // ───── late pickups ─────
  async lateViews(rows: LatePickup[]) {
    if (!rows.length) return [];
    const n = await this.names(rows.map((r) => r.createdBy));
    const k = await this.kids(rows.map((r) => r.childId));
    return rows.map((r) => ({
      id: r.id, childId: r.childId, childName: k.get(r.childId)?.fullName ?? null, classId: r.classId, className: k.get(r.childId)?.classRoom?.name ?? null,
      date: r.date, time: r.time, pickerName: r.pickerName, note: r.note, status: r.cancelledAt ? 'cancelled' : 'active',
      createdBy: r.createdBy, createdByName: r.createdBy ? n.get(r.createdBy) ?? null : null, createdAt: r.createdAt, cancelledAt: r.cancelledAt,
    }));
  }

  @Post('children/:id/late-pickups') @Roles('parent', 'admin')
  async createLate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateLatePickupDto) {
    const child = await this.childFor(u, id, true);
    if (child.status === 'withdrawn') throw BadRequest('Trẻ đã nghỉ học', 'CHILD_WITHDRAWN');
    const today = todayStr();
    if (dto.date < today) throw BadRequest('Không thể báo đón muộn cho ngày đã qua', 'DATE_IN_PAST');
    if (dto.date > addDays(today, 30)) throw BadRequest('Chỉ báo trước tối đa 30 ngày', 'DATE_TOO_FAR');
    if (dto.time < schoolOpenTime() || dto.time > latestPickupTime())
      throw new AppError(400, 'OUTSIDE_SCHOOL_HOURS', `Giờ đón phải trong khoảng ${schoolOpenTime()}–${latestPickupTime()}`, { schoolOpenTime: schoolOpenTime(), latestPickupTime: latestPickupTime() });
    if (dto.date === today && dto.time <= vnNowHM()) throw BadRequest('Giờ đón đã qua', 'TIME_PASSED');
    await this.assertSchoolDay(dto.date);
    const exists = await this.ds.getRepository(LatePickup).findOne({ where: { childId: id, date: dto.date, cancelledAt: IsNull() } });
    if (exists) throw new AppError(409, 'LATE_PICKUP_EXISTS', 'Đã có báo đón muộn cho ngày này – hãy hủy rồi gửi lại', { id: exists.id });
    const row = await this.ds.getRepository(LatePickup).save({ childId: id, classId: child.classId, date: dto.date, time: dto.time,
      pickerName: dto.pickerName?.trim() || null, note: dto.note?.trim() || null, createdBy: u.id }).catch((e) => {
      if (e?.driverError?.code === '23505') throw new AppError(409, 'LATE_PICKUP_EXISTS', 'Đã có báo đón muộn cho ngày này');
      throw e;
    });
    await this.notify.send(await this.absences.classTeacherIds(child.classId), {
      type: 'late_pickup', title: `Đón muộn: ${child.fullName}${child.classRoom ? ` (${child.classRoom.name})` : ''} – ${dto.time} ngày ${dto.date}`,
      body: [row.pickerName ? `Người đón: ${row.pickerName}` : null, row.note].filter(Boolean).join(' – ') || null, data: { latePickupId: row.id, childId: id, date: dto.date }, refId: row.id,
    });
    return (await this.lateViews([row]))[0];
  }

  @Get('children/:id/late-pickups') @Roles('parent', 'admin', 'teacher')
  async listLate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: RangeQ) {
    await this.childFor(u, id, false);
    const qb = this.ds.getRepository(LatePickup).createQueryBuilder('l').where('l.child_id = :id AND l.date >= :from', { id, from: q.from ?? addDays(todayStr(), -30) });
    if (q.to) qb.andWhere('l.date <= :to', { to: q.to });
    return { items: await this.lateViews(await qb.orderBy('l.date', 'DESC').getMany()) };
  }

  @Delete('late-pickups/:id') @Roles('parent', 'admin') @HttpCode(200)
  async cancelLate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.ds.getRepository(LatePickup).findOne({ where: { id } });
    if (!row) throw NotFound('Không tìm thấy báo đón muộn');
    const child = await this.childFor(u, row.childId, true);
    if (!row.cancelledAt) {
      await this.ds.getRepository(LatePickup).update(id, { cancelledAt: new Date(), cancelledBy: u.id });
      await this.notify.send(await this.absences.classTeacherIds(child.classId), {
        type: 'late_pickup_cancelled', title: `Hủy đón muộn: ${child.fullName} – ${row.date}`, data: { latePickupId: id, childId: row.childId }, refId: id });
    }
    return (await this.lateViews([await this.ds.getRepository(LatePickup).findOneByOrFail({ id })]))[0];
  }

  // ───── class feed (pinned on the attendance screen) ─────
  @Get('classes/:id/parent-messages') @Roles('teacher', 'admin')
  async feed(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: DateQ) {
    await this.access.getClassOr404(id);
    if (!this.access.canOperateClass(u, id) && !((!q.date || q.date === todayStr()) && await this.substituteToday(u, id))) this.access.assertOperateClass(u, id);
    const date = q.date ?? todayStr();
    const kidIds: string[] = (await this.ds.query(`SELECT id FROM children WHERE class_id = $1`, [id])).map((r: any) => r.id);
    const holiday = (await confirmedHolidays(this.ds.manager, date, date)).get(date) ?? null;
    const absRows = kidIds.length ? await this.ds.getRepository(Absence).createQueryBuilder('a')
      .innerJoin('absence_days', 'd', 'd.absence_id = a.id AND d.date = :date AND d.cancelled_at IS NULL', { date })
      .where('a.child_id IN (:...ids)', { ids: kidIds }).orderBy('a.created_at', 'ASC').getMany() : [];
    const meds = kidIds.length ? await this.ds.getRepository(Medicine).find({ where: { childId: In(kidIds), date, cancelledAt: IsNull() }, order: { createdAt: 'ASC' } }) : [];
    const lates = kidIds.length ? await this.ds.getRepository(LatePickup).find({ where: { childId: In(kidIds), date, cancelledAt: IsNull() }, order: { time: 'ASC' } }) : [];
    const medicines = await this.medicineViews(meds);
    return {
      date, holiday: holiday ? { id: holiday.id, name: holiday.name, kind: holiday.kind, reason: holiday.reason } : null,
      absences: await this.absences.views(u, absRows), medicines, latePickups: await this.lateViews(lates),
      counts: { absences: absRows.length, medicines: medicines.length, dosesPending: medicines.reduce((s, m) => s + m.doses.filter((d) => !d.givenAt).length, 0), latePickups: lates.length },
    };
  }
}
