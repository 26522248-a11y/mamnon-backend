import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { Brackets, DataSource, In, IsNull, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles, AllowWhenPasswordChangeRequired } from '../common/auth';
import { addDays, dayDiff, todayStr } from '../common/dates';
import { NotificationsService } from '../notifications/notifications.service';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { imageUploadOptions, saveImage, sendImage } from '../common/upload';
import { Response } from 'express';
import { ABSENCE_REASONS, AbsenceDay, AbsenceReason, Absence, Attendance, AttendanceHistory, AttStatus, AuthorizedPicker, Child, ClassRoom, Guardian, Pickup, PickupCallAttempt, PickupRequest, User } from '../database/entities';
import { ESCALATE_MINUTES, maskId, PickupSafetyService } from '../pickup/pickup-safety.service';
import { cleanName, parsePhone } from '../imports/children-import';
import { childrenInGap, notInEnrollmentGap } from '../children/enrollment';
import { recordAudit } from '../common/audit';
import { schoolInfo } from '../common/school';
import { Request } from 'express';
import { isExpired, requestBlockers } from '../pickup/request-rules';
import { AbsencesService, confirmedHolidays } from '../absences/absences.service';

export const TEACHER_EDIT_WINDOW_DAYS = 3;

export class AttendanceQuery {
  @ApiPropertyOptional({ example: '2026-10-09', description: 'Mặc định hôm nay (giờ VN)' }) @IsOptional() @IsDateString() date?: string;
}
class AttendanceItemDto {
  @ApiProperty() @IsUUID() childId!: string;
  @ApiProperty({ enum: ['present', 'absent', 'late'] }) @IsIn(['present', 'absent', 'late']) status!: AttStatus;
  @ApiPropertyOptional({ example: 'Ốm, mẹ xin nghỉ' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ deprecated: true, description: 'Bỏ qua (giữ để tương thích): máy chủ tự tính – chỉ báo vắng của phụ huynh trước giờ chốt mới được hoàn tiền ăn' })
  @IsOptional() @IsBoolean() notifiedInAdvance?: boolean;
  @ApiPropertyOptional({ enum: ABSENCE_REASONS, nullable: true,
    description: 'Lý do vắng (status=absent) → "Vắng có phép". Không gửi = giữ nguyên (nếu trạng thái không đổi); null = xóa lý do. Chuyển sang có mặt/muộn, hoặc chuyển sang vắng mà không kèm lý do = không lý do.' })
  @IsOptional() @IsIn(ABSENCE_REASONS) absenceReason?: AbsenceReason | null;
  @ApiPropertyOptional({ default: false, description: 'Chủ động ghi đè báo vắng của phụ huynh (có mặt): không hoàn tiền, báo bếp. "Tất cả có mặt" KHÔNG gửi cờ này.' })
  @IsOptional() @IsBoolean() overrideAbsence?: boolean;
}
export class PutAttendanceDto {
  @ApiProperty({ example: '2026-10-09' }) @IsDateString() date!: string;
  @ApiProperty({ type: [AttendanceItemDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AttendanceItemDto) items!: AttendanceItemDto[];
}
export class PickupDto {
  @ApiPropertyOptional({ description: 'Bố mẹ / người giám hộ trong danh sách (canPickup=true): giao luôn' }) @IsOptional() @IsUUID() guardianId?: string;
  @ApiPropertyOptional({ description: 'Người đón hộ phụ huynh đã đăng ký và BGH đã duyệt: giao luôn' }) @IsOptional() @IsUUID() authorizedPickerId?: string;
  @ApiPropertyOptional({ description: 'Người ngoài danh sách: yêu cầu đã được CẢ phụ huynh VÀ nhà trường duyệt, chưa hết hạn' }) @IsOptional() @IsUUID() pickupRequestId?: string;
  @ApiPropertyOptional({ description: 'ISO 8601, mặc định thời điểm hiện tại' }) @IsOptional() @IsISO8601() pickedUpAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class CreatePickupRequestDto {
  @ApiProperty({ example: 'Nguyễn Văn Tư' }) @IsString() @MinLength(1) @MaxLength(120) pickerName!: string;
  @ApiProperty({ example: '0909123456' }) @Matches(/^[0-9+ ]{8,20}$/) pickerPhone!: string;
  @ApiPropertyOptional({ example: 'Chú ruột' }) @IsOptional() @IsString() @MaxLength(40) relation?: string;
  @ApiProperty({ example: 'Mẹ bé gọi báo nhờ chú đón', description: 'BẮT BUỘC (thiếu/rỗng → 400 VALIDATION_ERROR): ai báo, báo lúc nào' }) @IsString() @MinLength(1) @MaxLength(500) note!: string;
  @ApiPropertyOptional({ example: '079123456789', description: 'CCCD người đón (12 số, tuỳ chọn) – dùng cảnh báo một người đón nhiều bé' }) @IsOptional() @Matches(/^\d{12}$/, { message: 'Số giấy tờ tùy thân phải đủ 12 chữ số' }) pickerIdNumber?: string;
  @ApiPropertyOptional({ type: 'string', format: 'binary', description: 'Ảnh người đón (tuỳ chọn)' }) @IsOptional() photo?: any;
}
export class DecisionDto {
  @ApiPropertyOptional({ example: 'Không quen người này', description: 'Bắt buộc khi nhà trường (BGH / trực đón) TỪ CHỐI; duyệt thì không cần' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class OnBehalfDto {
  @ApiProperty({ enum: ['approve', 'reject'] }) @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @ApiProperty({ example: 'Đã gọi số 0912…, mẹ bé đồng ý', description: 'Bắt buộc: đã liên lạc phụ huynh thế nào' }) @IsString() @MinLength(1) @MaxLength(500) note!: string;
}
export class CallAttemptDto {
  @ApiProperty({ example: '0912000001' }) @Matches(/^[0-9+ ]{8,20}$/) phone!: string;
  @ApiProperty({ enum: ['no_answer', 'busy', 'wrong_number', 'confirmed', 'rejected', 'other'], description: "Chỉ ghi nhận; 'confirmed' KHÔNG tự duyệt hay tự giao bé" })
  @IsIn(['no_answer', 'busy', 'wrong_number', 'confirmed', 'rejected', 'other']) outcome!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() guardianId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class FeedQuery {
  @ApiPropertyOptional({ description: 'Mặc định hôm nay' }) @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
}
export class IdentityQuery {
  @ApiProperty({ enum: ['guardian', 'authorized_picker', 'pickup_request'] }) @IsIn(['guardian', 'authorized_picker', 'pickup_request']) kind!: string;
  @ApiProperty() @IsUUID() id!: string;
}
export class PickupRequestQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected', 'expired'] }) @IsOptional() @IsIn(['pending', 'approved', 'rejected', 'expired']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}

/** Teacher: today and up to 3 days back. Admin: any past date. Nobody: future dates. */
export function assertDateEditable(u: AuthUser, date: string) {
  const diff = dayDiff(todayStr(), date);
  if (diff < 0) throw BadRequest('Không thể ghi cho ngày trong tương lai', 'DATE_IN_FUTURE');
  if (u.role !== 'admin' && diff > TEACHER_EDIT_WINDOW_DAYS)
    throw new AppError(403, 'EDIT_WINDOW_EXPIRED', `Giáo viên chỉ được sửa trong ${TEACHER_EDIT_WINDOW_DAYS} ngày gần nhất; liên hệ Ban giám hiệu`);
}

const pickupView = (p: Pickup) => ({
  id: p.id, attendanceId: p.attendanceId, guardianId: p.guardianId, authorizedPickerId: p.authorizedPickerId, pickupRequestId: p.pickupRequestId,
  pickerKind: p.pickerKind, pickedUpByName: p.pickedUpByName, relation: p.relation, pickedUpAt: p.pickedUpAt, isAuthorized: p.isAuthorized, note: p.note, recordedBy: p.recordedBy,
  photoUrl: p.photoUrl ? `/api/v1/attendance/${p.attendanceId}/pickup-photo` : null,
});
export const PICKUP_REQUEST_TTL_MS = 2 * 60 * 60 * 1000;
/** min(now + 2h, midnight ending the school day in Vietnam time, UTC+7 without DST). */
export function pickupRequestExpiry(now = new Date()): Date {
  const endOfDay = new Date(`${addDays(todayStr(), 1)}T00:00:00+07:00`);
  return new Date(Math.min(now.getTime() + PICKUP_REQUEST_TTL_MS, endOfDay.getTime()));
}
export { requestBlockers };
const requestView = (r: PickupRequest & { child?: Child }, names: Map<string, string> = new Map()) => ({
  id: r.id, attendanceId: r.attendanceId, childId: r.childId, childName: r.child?.fullName, classId: r.classId, className: names.get(`class:${r.classId}`) ?? null,
  pickerName: r.pickerName, pickerPhone: r.pickerPhone, pickerIdNumberMasked: maskId(r.pickerIdNumber), relation: r.relation, note: r.note,
  photoUrl: r.photoUrl ? `/api/v1/pickup-requests/${r.id}/photo` : null,
  status: isExpired(r) && r.status === 'pending' ? 'expired' : r.status, expiresAt: r.expiresAt, requestedBy: r.requestedBy, createdAt: r.createdAt,
  /** when the 15-minute call prompt starts (createdAt + PICKUP_ESCALATE_MINUTES) */
  dueAt: new Date(new Date(r.createdAt).getTime() + ESCALATE_MINUTES() * 60_000),
  parent: { status: r.parentStatus, decidedBy: r.parentDecidedBy, decidedByName: r.parentDecidedBy ? names.get(r.parentDecidedBy) ?? null : null, decidedAt: r.parentDecidedAt, note: r.parentNote, channel: r.parentChannel },
  school: { status: r.schoolStatus, decidedBy: r.schoolDecidedBy, decidedByName: r.schoolDecidedBy ? names.get(r.schoolDecidedBy) ?? null : null, decidedAt: r.schoolDecidedAt, note: r.schoolNote,
    role: r.schoolDecidedRole as 'admin' | 'duty' | null },
  blockers: requestBlockers(r), readyForHandover: requestBlockers(r).length === 0,
  // legacy single-decision fields (last decision)
  decidedBy: r.decidedBy, decidedByName: r.decider?.name ?? null, decidedOnBehalf: r.decidedOnBehalf, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
});
@ApiTags('attendance') @ApiBearerAuth()
@Controller()
export class AttendanceController {
  constructor(
    @InjectRepository(Attendance) private att: Repository<Attendance>,
    @InjectRepository(AttendanceHistory) private history: Repository<AttendanceHistory>,
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(Guardian) private guardians: Repository<Guardian>,
    @InjectRepository(Pickup) private pickups: Repository<Pickup>,
    @InjectRepository(PickupRequest) private requests: Repository<PickupRequest>,
    private access: AccessService, private ds: DataSource, private notify: NotificationsService, private safety: PickupSafetyService, private absences: AbsencesService,
  ) {}

  /** Lazily flips overdue pending requests to 'expired'. */
  private async sweepExpired() {
    await this.requests.createQueryBuilder().update().set({ status: 'expired' })
      .where("status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()").execute();
  }

  private async sheet(classId: string, date: string) {
    // withdrawn children stay on sheets up to (and including) their leave date
    const kids = await this.children.createQueryBuilder('c').where('c.class_id = :classId', { classId })
      .andWhere("(c.status = 'active' OR (c.status = 'withdrawn' AND c.leave_date >= :date))", { date }).andWhere(notInEnrollmentGap(':date')).orderBy('c.fullName', 'ASC').getMany();
    const rows = await this.att.find({ where: { classId, date }, relations: { pickup: true } });
    const byChild = new Map(rows.map((r) => [r.childId, r]));
    const extra = rows.filter((r) => !kids.some((k) => k.id === r.childId));
    const extraKids = extra.length ? await this.children.find({ where: { id: In(extra.map((r) => r.childId)) } }) : [];
    await this.sweepExpired();
    const allIds = [...kids, ...extraKids].map((k) => k.id);
    const excused = allIds.length ? await this.ds.getRepository(AbsenceDay).createQueryBuilder('d').innerJoinAndSelect('d.absence', 'a')
      .where('d.child_id IN (:...ids) AND d.date = :date AND d.cancelled_at IS NULL', { ids: allIds, date }).getMany() : [];
    const exBy = new Map(excused.map((d) => [d.childId, d]));
    const pending = rows.length ? await this.requests.find({ where: { attendanceId: In(rows.map((r) => r.id)), status: 'pending' } }) : [];
    return [...kids, ...extraKids].map((k) => {
      const r = byChild.get(k.id);
      return {
        attendanceId: r?.id ?? null, childId: k.id, fullName: k.fullName, allergies: k.allergies ?? undefined,
        status: r?.status ?? null, note: r?.note ?? null, notifiedInAdvance: r?.notifiedInAdvance ?? false, recorded: !!r,
        photoConsent: k.photoConsent,
        // excused ("có phép") = active parent report OR teacher-given reason; refundEligible is independent
        excused: r?.status === 'absent' && ((!!exBy.get(k.id) && !exBy.get(k.id)!.overridden) || !!r?.absenceReason),
        excusedBy: r?.status !== 'absent' ? null : exBy.get(k.id) && !exBy.get(k.id)!.overridden ? 'parent' : r?.absenceReason ? 'teacher' : null,
        excusedOverridden: !!exBy.get(k.id)?.overridden,
        absenceId: exBy.get(k.id)?.absenceId ?? r?.absenceId ?? null,
        absenceReason: r ? r.absenceReason : null,
        absenceNote: exBy.get(k.id)?.absence.note ?? null,
        refundEligible: r?.status === 'absent' && !!r?.notifiedInAdvance,
        pickup: r?.pickup ? pickupView(r.pickup) : null,
        pendingPickupRequests: r ? pending.filter((p) => p.attendanceId === r.id).length : 0,
      };
    });
  }

  @Get('classes/:id/attendance')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: AttendanceQuery) {
    await this.access.getClassOr404(id);
    this.access.assertOperateClass(u, id); // accountant & parent: 403 (no attendance detail at class level)
    const date = q.date ?? todayStr();
    const holiday = (await confirmedHolidays(this.ds.manager, date, date)).get(date);
    return { classId: id, date, holiday: holiday ? { id: holiday.id, name: holiday.name } : null, items: await this.sheet(id, date) };
  }

  /** Bulk save. Every create/change is written to attendance_history (who, when, old → new). */
  @Put('classes/:id/attendance') @Roles('admin', 'teacher')
  async put(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutAttendanceDto) {
    await this.access.getClassOr404(id);
    this.access.assertOperateClass(u, id);
    assertDateEditable(u, dto.date);
    const hol = (await confirmedHolidays(this.ds.manager, dto.date, dto.date)).get(dto.date);
    if (hol) throw new AppError(400, 'SCHOOL_HOLIDAY', `Trường nghỉ (${hol.name}) – không điểm danh`, { holiday: { id: hol.id, name: hol.name } });
    const ids = dto.items.map((i) => i.childId);
    if (new Set(ids).size !== ids.length) throw BadRequest('Trùng trẻ trong danh sách điểm danh');
    if (ids.length) {
      const kids = await this.children.find({ where: { id: In(ids) } });
      const bad = ids.filter((cid) => kids.find((k) => k.id === cid)?.classId !== id);
      if (bad.length) throw BadRequest(`Trẻ không thuộc lớp này: ${bad.join(', ')}`, 'CHILD_NOT_IN_CLASS');
      const gone = kids.filter((k) => k.status === 'withdrawn' && (!k.leaveDate || dto.date > k.leaveDate));
      if (gone.length) throw BadRequest(`Trẻ đã nghỉ học, không điểm danh sau ngày nghỉ: ${gone.map((k) => `${k.fullName} (${k.leaveDate})`).join(', ')}`, 'CHILD_WITHDRAWN');
      const gap = await childrenInGap(this.ds, ids, dto.date); // B12: between leaving and re-enrolling
      if (gap.size) throw BadRequest(`Trẻ chưa học lại vào ngày này: ${kids.filter((k) => gap.has(k.id)).map((k) => `${k.fullName} (học lại từ ${k.enrolledAt})`).join(', ')}`, 'CHILD_NOT_ENROLLED');
    }
    const skipped: { childId: string; reason: string }[] = [];
    const overrides: { childId: string; absenceId: string }[] = [];
    await this.ds.transaction(async (m) => {
      const exDays = ids.length ? await m.createQueryBuilder(AbsenceDay, 'd').setLock('pessimistic_write')
        .where('d.child_id IN (:...ids) AND d.date = :d AND d.cancelled_at IS NULL', { ids, d: dto.date }).getMany() : [];
      const exBy = new Map(exDays.map((d) => [d.childId, d]));
      const reasons = exDays.length ? new Map((await m.find(Absence, { where: { id: In(exDays.map((d) => d.absenceId)) } })).map((a) => [a.id, a.reason])) : new Map();
      const existing = ids.length
        ? await m.createQueryBuilder(Attendance, 'a').setLock('pessimistic_write')
            .where('a.child_id IN (:...ids)', { ids }).andWhere('a.date = :d', { d: dto.date }).getMany()
        : [];
      const byChild = new Map(existing.map((a) => [a.childId, a]));
      for (const i of dto.items) {
        const old = byChild.get(i.childId);
        const day = exBy.get(i.childId);
        let note = i.note ?? null;
        // Refund eligibility is computed by the server (client notifiedInAdvance is ignored): only a parent report made before
        // the cutoff makes an absence refundable. Legacy rows (before round 2) keep their stored flag while they stay absent.
        let notified = i.status === 'absent' && !!old && old.status === 'absent' && !old.absenceId && old.notifiedInAdvance;
        // reason: only for absent. Sent value (incl. null = clear) wins; missing = unchanged while the status stays absent,
        // a switch to absent without a reason = plain absent (no reason).
        const statusChanged = !old || old.status !== i.status;
        let absenceReason: AbsenceReason | null = i.status !== 'absent' ? null
          : i.absenceReason !== undefined ? i.absenceReason ?? null
          : statusChanged ? null : old?.absenceReason ?? null;
        let absenceId: string | null = old?.absenceId ?? null;
        if (day && !day.overridden) {
          if (i.status !== 'absent' && !i.overrideAbsence) { skipped.push({ childId: i.childId, reason: 'EXCUSED_ABSENCE' }); continue; }
          if (i.status === 'absent') {
            // excused day stays excused: refund flag comes from the report, not from the sheet
            notified = day.refundEligible; absenceId = day.absenceId;
            if (i.absenceReason === undefined && !old) absenceReason = reasons.get(day.absenceId) ?? null;
            if (i.note === undefined) note = old?.note ?? null;
          } else {
            await this.absences.override(m, day, u.id);
            overrides.push({ childId: i.childId, absenceId: day.absenceId });
            absenceId = day.absenceId;
          }
        }
        if (!old) {
          const a = await m.save(Attendance, m.create(Attendance, { childId: i.childId, classId: id, date: dto.date, status: i.status, note, notifiedInAdvance: notified, absenceReason, absenceId, recordedBy: u.id }));
          await m.save(AttendanceHistory, m.create(AttendanceHistory, { attendanceId: a.id, action: 'create', oldStatus: null, oldNote: null, oldNotified: null,
            newStatus: i.status, newNote: note, newNotified: notified, changedBy: u.id }));
        } else if (old.status !== i.status || (old.note ?? null) !== note || old.notifiedInAdvance !== notified || (old.absenceReason ?? null) !== absenceReason) {
          await m.update(Attendance, old.id, { status: i.status, note, notifiedInAdvance: notified, absenceReason, absenceId, recordedBy: u.id, classId: id });
          await m.save(AttendanceHistory, m.create(AttendanceHistory, { attendanceId: old.id, action: 'update', oldStatus: old.status, oldNote: old.note,
            oldNotified: old.notifiedInAdvance, newStatus: i.status, newNote: note, newNotified: notified, changedBy: u.id }));
        }
      }
    });
    if (overrides.length) {
      const kids = await this.children.find({ where: { id: In(overrides.map((o) => o.childId)) }, relations: { classRoom: true } });
      for (const o of overrides) {
        const k = kids.find((x) => x.id === o.childId)!;
        await this.absences.notifyOverride(k.id, k.fullName, k.classRoom?.name ?? null, dto.date, o.absenceId, u.name);
      }
    }
    return { classId: id, date: dto.date, holiday: null, skipped, items: await this.sheet(id, dto.date) };
  }

  private async attendanceForStaff(u: AuthUser, id: string) {
    const a = await this.att.findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy bản ghi điểm danh');
    this.access.assertOperateClass(u, a.classId);
    return a;
  }

  @Get('attendance/:id/history') @Roles('admin', 'teacher')
  async getHistory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.attendanceForStaff(u, id);
    const rows = await this.history.find({ where: { attendanceId: id }, relations: { changer: true }, order: { changedAt: 'ASC' } });
    return {
      attendanceId: id, childId: a.childId, date: a.date, current: { status: a.status, note: a.note, notifiedInAdvance: a.notifiedInAdvance },
      items: rows.map((h) => ({
        id: h.id, action: h.action, old: h.action === 'create' ? null : { status: h.oldStatus, note: h.oldNote, notifiedInAdvance: h.oldNotified },
        new: { status: h.newStatus, note: h.newNote, notifiedInAdvance: h.newNotified },
        changedBy: h.changedBy, changedByName: h.changer?.name ?? null, changedByRole: h.changer?.role ?? null, changedAt: h.changedAt,
      })),
    };
  }

  private async names(rows: PickupRequest[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.parentDecidedBy, r.schoolDecidedBy]).filter(Boolean) as string[])];
    const us = ids.length ? await this.ds.getRepository(User).find({ where: { id: In(ids) }, select: { id: true, name: true } }) : [];
    const cids = [...new Set(rows.map((r) => r.classId).filter(Boolean))];
    const cs = cids.length ? await this.ds.getRepository(ClassRoom).find({ where: { id: In(cids) }, select: { id: true, name: true } }) : [];
    return new Map([...us.map((x) => [x.id, x.name] as [string, string]), ...cs.map((c) => [`class:${c.id}`, c.name] as [string, string])]);
  }
  /** Staff view: + 15-minute escalation info and same-picker warnings. */
  private async staffView(r: PickupRequest, names?: Map<string, string>) {
    const date = await this.safety.requestDate(r);
    return {
      ...requestView(r, names ?? (await this.names([r]))),
      escalation: await this.safety.escalation(r),
      warnings: this.safety.multiWarning(await this.safety.samePickerToday(r.childId, r.pickerPhone, r.pickerIdNumber, date), r.pickerName),
    };
  }
  private async parentIds(childId: string) { return this.notify.parentIdsOfChildren([childId]); }

  /**
   * Hand the child over (API-enforced, PM rules):
   *  - guardianId: listed parent/guardian with canPickup -> direct;
   *  - authorizedPickerId: person registered by a parent AND approved by admin -> direct (pending/rejected = off-list -> 403);
   *  - pickupRequestId: off-list person; needs parent approved AND school approved, not expired, and the school approver
   *    must not be the one handing over. Already handed over -> 409. Parents are notified "Bé đã được X đón lúc HH:MM".
   */
  @Post('attendance/:id/pickup') @Roles('admin', 'teacher')
  @ApiConsumes('application/json', 'multipart/form-data') @UseInterceptors(FileInterceptor('photo', imageUploadOptions))
  async pickup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PickupDto, @UploadedFile() file?: Express.Multer.File) {
    const a = await this.attendanceForStaff(u, id);
    assertDateEditable(u, a.date);
    if (a.status === 'absent') throw BadRequest('Trẻ vắng mặt, không thể ghi nhận đón', 'CHILD_ABSENT');
    if ([dto.guardianId, dto.authorizedPickerId, dto.pickupRequestId].filter(Boolean).length !== 1)
      throw BadRequest('Cần đúng một trong: guardianId (bố mẹ / người giám hộ), authorizedPickerId (người đón hộ đã duyệt) hoặc pickupRequestId (người ngoài danh sách đã đủ 2 bước duyệt)', 'PICKUP_PERSON_REQUIRED');
    if (await this.pickups.exist({ where: { attendanceId: id } })) throw new AppError(409, 'ALREADY_PICKED_UP', 'Bé đã được giao rồi');

    let name: string, relation: string | null, kind: string, phone: string | null = null, idNumber: string | null = null;
    let guardianId: string | null = null, pickerId: string | null = null, requestId: string | null = null;
    if (dto.guardianId) {
      const g = await this.guardians.findOne({ where: { id: dto.guardianId } });
      if (!g || g.childId !== a.childId) throw BadRequest('Người giám hộ không thuộc trẻ này', 'INVALID_GUARDIAN');
      if (!g.canPickup) throw new AppError(403, 'PICKUP_NOT_ALLOWED', 'Người này không được phép đón trẻ');
      guardianId = g.id; name = g.fullName; relation = g.relation; kind = 'guardian'; phone = g.phone; idNumber = g.idNumber;
    } else if (dto.authorizedPickerId) {
      const p = await this.ds.getRepository(AuthorizedPicker).findOne({ where: { id: dto.authorizedPickerId } });
      if (!p || p.childId !== a.childId || p.deletedAt) throw BadRequest('Người đón hộ không thuộc trẻ này (hoặc đã bị xoá)', 'INVALID_AUTHORIZED_PICKER');
      if (p.status !== 'approved') throw new AppError(403, 'PICKER_NOT_APPROVED',
        p.status === 'pending' ? 'Người đón hộ chưa được Ban giám hiệu duyệt: coi như người ngoài danh sách, cần tạo yêu cầu đón (đủ 2 bước)' : 'Người đón hộ đã bị từ chối: không được giao trẻ');
      pickerId = p.id; name = p.fullName; relation = p.relation; kind = 'authorized_picker'; phone = p.phone1; idNumber = p.idNumber;
    } else {
      await this.sweepExpired();
      const r = await this.requests.findOne({ where: { id: dto.pickupRequestId } });
      if (!r || r.attendanceId !== a.id) throw BadRequest('Yêu cầu đón không thuộc bản điểm danh này', 'INVALID_PICKUP_REQUEST');
      if (r.parentStatus === 'rejected' || r.schoolStatus === 'rejected' || r.status === 'rejected')
        throw new AppError(403, 'PICKUP_REQUEST_REJECTED', 'Yêu cầu đón đã bị từ chối, không được giao trẻ');
      if (isExpired(r)) throw new AppError(403, 'PICKUP_REQUEST_EXPIRED', 'Yêu cầu đón đã hết hạn (2 giờ hoặc hết ngày); tạo yêu cầu mới');
      // code kept from v1 (PICKUP_REQUEST_PENDING); details = which step is missing: PARENT_PENDING / SCHOOL_PENDING
      if (r.parentStatus !== 'approved' || r.schoolStatus !== 'approved') throw new AppError(403, 'PICKUP_REQUEST_PENDING',
        r.parentStatus !== 'approved' && r.schoolStatus !== 'approved' ? 'Cần phụ huynh xác nhận VÀ nhà trường (BGH / trực đón) duyệt trước khi giao bé'
          : r.parentStatus !== 'approved' ? 'Phụ huynh chưa xác nhận người đón' : 'Nhà trường (BGH / trực đón) chưa duyệt người đón',
        requestBlockers(r));
      if (r.schoolDecidedBy === u.id) throw new AppError(403, 'APPROVER_CANNOT_HAND_OVER', 'Người duyệt phần nhà trường không được tự giao bé; người khác phải giao');
      requestId = r.id; name = r.pickerName; relation = r.relation; kind = 'request'; phone = r.pickerPhone; idNumber = r.pickerIdNumber;
    }
    // U10/U5: optional hand-over photo (magic bytes JPG/PNG/HEIC→JPEG, else 400). First pick-up of an approved picker without photo → becomes their photo.
    const photo = file ? await saveImage(file) : null;
    if (photo && pickerId) await this.ds.getRepository(AuthorizedPicker).createQueryBuilder().update().set({ photoUrl: photo }).where('id = :id AND photo_url IS NULL', { id: pickerId }).execute();
    const warnings = this.safety.multiWarning(await this.safety.samePickerToday(a.childId, phone, idNumber, a.date), name);
    let p: Pickup;
    try {
      p = await this.pickups.save(this.pickups.create({
        attendanceId: id, guardianId, authorizedPickerId: pickerId, pickupRequestId: requestId, pickerKind: kind, pickerPhone: phone, pickerIdNumber: idNumber,
        pickedUpByName: name, relation, pickedUpAt: dto.pickedUpAt ? new Date(dto.pickedUpAt) : new Date(), isAuthorized: true, note: dto.note ?? null, recordedBy: u.id, photoUrl: photo,
      }));
    } catch (e: any) {
      if (e?.driverError?.code === '23505') throw new AppError(409, 'ALREADY_PICKED_UP', 'Bé đã được giao rồi');
      throw e;
    }
    const child = await this.children.findOne({ where: { id: a.childId } });
    const sent = await this.safety.notifyPickedUp({ childId: a.childId, childName: child?.fullName ?? '', pickerName: name, relation, at: p.pickedUpAt,
      parentIds: await this.parentIds(a.childId), pickupId: p.id, attendanceId: id, handedOverBy: { id: u.id, name: u.name }, hasPhoto: !!photo, schoolPhone: schoolInfo().phone });
    return { ...pickupView(p), handedOverBy: u.id, handedOverByName: u.name, warnings, notified: sent };
  }

  /** U10: hand-over photo – staff of the class, admin, or a parent of the child. 404 when none. */
  @Get('attendance/:id/pickup-photo')
  async pickupPhoto(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const a = await this.ds.getRepository(Attendance).findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy');
    const ok = u.role === 'admin' || (u.role === 'teacher' && u.classIds.includes(a.classId)) || (u.role === 'parent' && u.childIds.includes(a.childId));
    if (!ok) throw NotFound('Không tìm thấy');
    const p = await this.pickups.findOne({ where: { attendanceId: id } });
    if (!p?.photoUrl) throw NotFound('Chưa có ảnh');
    await sendImage(res, p.photoUrl);
  }

  /** Handover screen: everyone who may pick this child up, with what is still missing. CCCD masked (full via /pickup-identity). */
  @Get('attendance/:id/pickup-options') @Roles('admin', 'teacher')
  async pickupOptions(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.attendanceForStaff(u, id);
    await this.sweepExpired();
    const child = await this.children.findOne({ where: { id: a.childId }, relations: { classRoom: true } });
    const done = await this.pickups.findOne({ where: { attendanceId: id } });
    const gs = await this.guardians.find({ where: { childId: a.childId }, order: { createdAt: 'ASC' } });
    const aps = await this.ds.getRepository(AuthorizedPicker).find({ where: { childId: a.childId, deletedAt: IsNull() }, order: { createdAt: 'ASC' } });
    const reqs = await this.requests.find({ where: { attendanceId: id }, order: { createdAt: 'DESC' } });
    const names = await this.names(reqs);
    return {
      attendanceId: id, date: a.date, status: a.status,
      child: { id: child!.id, fullName: child!.fullName, className: child!.classRoom?.name ?? null, photoUrl: child!.photoUrl ? `/api/v1/children/${child!.id}/photo` : null },
      pickedUp: done ? pickupView(done) : null,
      guardians: gs.map((g) => ({ kind: 'guardian', id: g.id, fullName: g.fullName, relation: g.relation, phone: g.phone, idNumberMasked: maskId(g.idNumber),
        hasAccount: !!g.userId, canPickup: g.canPickup, canHandOver: !done && g.canPickup && a.status !== 'absent', blockers: g.canPickup ? [] : ['NOT_ALLOWED'] })),
      authorizedPickers: aps.map((p) => ({ kind: 'authorized_picker', id: p.id, fullName: p.fullName, relation: p.relation, phone1: p.phone1, phone2: p.phone2,
        idNumberMasked: maskId(p.idNumber), photoUrl: p.photoUrl ? `/api/v1/authorized-pickers/${p.id}/photo` : null, status: p.status,
        canHandOver: !done && p.status === 'approved' && a.status !== 'absent', blockers: p.status === 'approved' ? [] : [p.status === 'pending' ? 'NOT_APPROVED_YET' : 'REJECTED'] })),
      requests: await Promise.all(reqs.map(async (r) => {
        const v = await this.staffView(r, names);
        const blockers = [...v.blockers, ...(r.schoolDecidedBy === u.id ? ['YOU_APPROVED'] : [])];
        return { kind: 'pickup_request', ...v, blockers, canHandOver: !done && a.status !== 'absent' && blockers.length === 0 };
      })),
    };
  }

  /** Full CCCD + photo for the handover screen. Admin / teacher of the class only; every call is audit-logged. */
  @Get('attendance/:id/pickup-identity') @Roles('admin', 'teacher')
  async pickupIdentity(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: IdentityQuery, @Req() req: Request) {
    const a = await this.attendanceForStaff(u, id);
    let out: { fullName: string; relation: string | null; idNumber: string | null; photoUrl: string | null; phones: string[] };
    if (q.kind === 'guardian') {
      const g = await this.guardians.findOne({ where: { id: q.id } });
      if (!g || g.childId !== a.childId) throw NotFound('Không tìm thấy người đón của bé này');
      out = { fullName: g.fullName, relation: g.relation, idNumber: g.idNumber, photoUrl: null, phones: [g.phone].filter(Boolean) as string[] };
    } else if (q.kind === 'authorized_picker') {
      const p = await this.ds.getRepository(AuthorizedPicker).findOne({ where: { id: q.id } });
      if (!p || p.childId !== a.childId || p.deletedAt) throw NotFound('Không tìm thấy người đón của bé này');
      out = { fullName: p.fullName, relation: p.relation, idNumber: p.idNumber, photoUrl: p.photoUrl ? `/api/v1/authorized-pickers/${p.id}/photo` : null, phones: [p.phone1, p.phone2].filter(Boolean) as string[] };
    } else {
      const r = await this.requests.findOne({ where: { id: q.id } });
      if (!r || r.attendanceId !== a.id) throw NotFound('Không tìm thấy yêu cầu đón của bé này');
      out = { fullName: r.pickerName, relation: r.relation, idNumber: r.pickerIdNumber, photoUrl: r.photoUrl ? `/api/v1/pickup-requests/${r.id}/photo` : null, phones: [r.pickerPhone] };
    }
    await this.safety.logSensitive(u, q.kind, q.id, a.childId, 'handover', a.id, req.ip ?? null);
    await recordAudit(this.ds, u, { action: 'pickup.identity_view', entityType: q.kind, entityId: q.id, childId: a.childId, ip: req.ip ?? null,
      data: { field: 'id_number', purpose: 'handover', attendanceId: a.id } });
    return { kind: q.kind, id: q.id, attendanceId: a.id, childId: a.childId, ...out, audited: true };
  }

  /** Teacher registers a person NOT on the list; needs parent AND school approval before handover. Push to the child's parents only. */
  @Post('attendance/:id/pickup-requests') @Roles('admin', 'teacher')
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(FileInterceptor('photo', imageUploadOptions))
  async createRequest(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePickupRequestDto,
    @UploadedFile() file?: Express.Multer.File) {
    const a = await this.attendanceForStaff(u, id);
    if (a.date !== todayStr()) throw BadRequest('Chỉ tạo yêu cầu đón cho ngày hôm nay', 'NOT_TODAY');
    if (a.status === 'absent') throw BadRequest('Trẻ vắng mặt, không thể tạo yêu cầu đón', 'CHILD_ABSENT');
    if (await this.pickups.exist({ where: { attendanceId: id } })) throw new AppError(409, 'ALREADY_PICKED_UP', 'Bé đã được giao rồi');
    const phone = parsePhone(dto.pickerPhone) ?? dto.pickerPhone.replace(/\s/g, '');
    const photo = file ? await saveImage(file) : null; // validated by magic bytes
    const r = await this.requests.save(this.requests.create({
      attendanceId: a.id, childId: a.childId, classId: a.classId, pickerName: cleanName(dto.pickerName), pickerPhone: phone, pickerIdNumber: dto.pickerIdNumber ?? null,
      relation: dto.relation ?? null, note: dto.note, photoUrl: photo, status: 'pending', parentStatus: 'pending', schoolStatus: 'pending', requestedBy: u.id, expiresAt: pickupRequestExpiry(),
    }));
    const child = await this.children.findOne({ where: { id: a.childId } });
    const delivery = await this.safety.notifyRequestCreated(r, child?.fullName ?? '', await this.parentIds(a.childId));
    return { ...(await this.staffView(r)), delivery };
  }

  private async canSeeRequest(u: AuthUser, r: PickupRequest) {
    if (u.role === 'admin' || (u.role === 'teacher' && u.classIds.includes(r.classId)) || (u.role === 'parent' && u.childIds.includes(r.childId))) return true;
    // the day's duty account approves off-list requests, so it may see them (that day only)
    return u.role !== 'parent' && (await this.safety.requestDate(r)) === todayStr() && (await this.safety.isOnDuty(u.id));
  }

  @AllowWhenPasswordChangeRequired() @Get('pickup-requests/:id/photo') @Roles('admin', 'teacher', 'parent', 'accountant')
  async requestPhoto(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const r = await this.requests.findOne({ where: { id } });
    if (!r) throw NotFound('Không tìm thấy yêu cầu đón');
    if (!(await this.canSeeRequest(u, r))) throw Forbidden('Không có quyền xem ảnh này');
    await sendImage(res, r.photoUrl);
  }

  /** admin: all; teacher: own classes; duty account: today's; parent: own children. */
  @Get('pickup-requests') @Roles('admin', 'teacher', 'parent', 'accountant')
  async listRequests(@CurrentUser() u: AuthUser, @Query() q: PickupRequestQuery) {
    await this.sweepExpired();
    const qb = this.requests.createQueryBuilder('r').leftJoinAndSelect('r.child', 'c').leftJoinAndSelect('r.decider', 'd')
      .leftJoin('r.attendance', 'a').orderBy('r.createdAt', 'DESC').take(200);
    const duty = u.role !== 'parent' && u.role !== 'admin' && (await this.safety.isOnDuty(u.id));
    if (u.role === 'teacher' || u.role === 'accountant') {
      if (duty) qb.andWhere(new Brackets((w) => w.where('r.class_id = ANY(:cids)', { cids: u.classIds }).orWhere('a.date = :today', { today: todayStr() })));
      else if (u.role === 'accountant') throw Forbidden('Chỉ tài khoản trực đón xem được yêu cầu đón');
      else qb.andWhere('r.class_id = ANY(:cids)', { cids: u.classIds });
    }
    if (u.role === 'parent') qb.andWhere('r.child_id = ANY(:kids)', { kids: u.childIds });
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.childId) qb.andWhere('r.child_id = :cid', { cid: q.childId });
    if (q.date) qb.andWhere('a.date = :d', { d: q.date });
    const rows = await qb.getMany();
    const names = await this.names(rows);
    if (u.role === 'parent') return rows.map((r) => ({ ...requestView(r, names), needsMyAction: r.status === 'pending' && r.parentStatus === 'pending' && !isExpired(r) }));
    return Promise.all(rows.map((r) => this.staffView(r, names)));
  }

  /** Parent feed (separate from the general inbox): pending requests needing my answer first, with picker photo. Default: today. */
  @AllowWhenPasswordChangeRequired() @Get('pickup-requests/feed') @Roles('parent')
  async feed(@CurrentUser() u: AuthUser, @Query() q: FeedQuery) {
    await this.sweepExpired();
    const date = q.date ?? todayStr();
    const kids = q.childId ? u.childIds.filter((k) => k === q.childId) : u.childIds;
    if (q.childId && !kids.length) throw Forbidden('Không phải con của bạn');
    const rows = kids.length ? await this.requests.createQueryBuilder('r').leftJoinAndSelect('r.child', 'c').leftJoin('r.attendance', 'a')
      .where('r.child_id = ANY(:kids)', { kids }).andWhere('a.date = :d', { d: date }).orderBy('r.createdAt', 'DESC').getMany() : [];
    const names = await this.names(rows);
    const items = rows.map((r) => ({ ...requestView(r, names), needsMyAction: r.status === 'pending' && r.parentStatus === 'pending' && !isExpired(r) }))
      .sort((x, y) => Number(y.needsMyAction) - Number(x.needsMyAction) || +new Date(y.createdAt) - +new Date(x.createdAt));
    return { date, pendingCount: items.filter((i) => i.needsMyAction).length, items };
  }

  @Get('pickup-requests/:id') @Roles('admin', 'teacher', 'parent', 'accountant')
  async getRequest(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.sweepExpired();
    const r = await this.requests.findOne({ where: { id }, relations: { child: true, decider: true } });
    if (!r) throw NotFound('Không tìm thấy yêu cầu đón');
    if (!(await this.canSeeRequest(u, r))) throw Forbidden('Không có quyền xem yêu cầu này');
    if (u.role === 'parent') return { ...requestView(r, await this.names([r])), needsMyAction: r.status === 'pending' && r.parentStatus === 'pending' && !isExpired(r) };
    return this.staffView(r);
  }

  private async decide(u: AuthUser, id: string, decision: 'approved' | 'rejected', dto: DecisionDto) {
    const r = await this.requests.findOne({ where: { id } });
    if (!r) throw NotFound('Không tìm thấy yêu cầu đón');
    let done: PickupRequest;
    if (u.role === 'parent') {
      if (!u.childIds.includes(r.childId)) throw Forbidden('Chỉ phụ huynh của trẻ được xác nhận');
      done = await this.safety.decideStep(u, id, 'parent', decision, { note: dto.note, channel: 'app' });
    } else {
      const role = await this.safety.schoolRole(u, await this.safety.requestDate(r));
      if (decision === 'rejected' && !dto.note?.trim()) throw BadRequest('Nhà trường từ chối phải ghi lý do', 'NOTE_REQUIRED');
      done = await this.safety.decideStep(u, id, 'school', decision, { note: dto.note, role });
    }
    return u.role === 'parent' ? requestView(done, await this.names([done])) : this.staffView(done);
  }

  @AllowWhenPasswordChangeRequired() @Post('pickup-requests/:id/confirm') @Roles('admin', 'parent', 'teacher', 'accountant') @HttpCode(200)
  @ApiOperation({ summary: 'Đồng ý: phụ huynh của bé → bước phụ huynh; BGH / tài khoản trực đón hôm nay → bước nhà trường. GV không trực → 403.' })
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) { return this.decide(u, id, 'approved', dto); }

  @AllowWhenPasswordChangeRequired() @Post('pickup-requests/:id/reject') @Roles('admin', 'parent', 'teacher', 'accountant') @HttpCode(200)
  @ApiOperation({ summary: 'Từ chối (nhà trường từ chối phải có note). Một bước từ chối → status rejected, giao bé 403.' })
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) { return this.decide(u, id, 'rejected', dto); }

  /** Admin records the PARENT's answer after reaching them by phone (bước phụ huynh, note required). The school step stays separate. */
  @Post('pickup-requests/:id/parent-decision') @Roles('admin') @HttpCode(200)
  async parentOnBehalf(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OnBehalfDto) {
    const done = await this.safety.decideStep(u, id, 'parent', dto.decision === 'approve' ? 'approved' : 'rejected', { note: dto.note, channel: 'on_behalf', onBehalf: true });
    await recordAudit(this.ds, u, { action: 'pickup_request.parent_on_behalf', entityType: 'pickup_request', entityId: id, childId: done.childId,
      after: { parentStatus: done.parentStatus, status: done.status }, reason: dto.note });
    return this.staffView(done);
  }

  /** 15-minute rule: log a phone call to the parent (who, which number, outcome). Never changes the request. */
  @Post('pickup-requests/:id/call-attempts') @Roles('admin', 'teacher', 'accountant')
  async logCall(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CallAttemptDto) {
    const r = await this.requests.findOne({ where: { id } });
    if (!r) throw NotFound('Không tìm thấy yêu cầu đón');
    if (!(await this.canSeeRequest(u, r))) throw Forbidden('Không có quyền với yêu cầu này');
    const phone = parsePhone(dto.phone) ?? dto.phone.replace(/\s/g, '');
    await this.ds.getRepository(PickupCallAttempt).insert({ pickupRequestId: id, calledBy: u.id, phone, guardianId: dto.guardianId ?? null, outcome: dto.outcome, note: dto.note ?? null });
    return this.staffView((await this.requests.findOne({ where: { id }, relations: { child: true, decider: true } }))!);
  }
}
