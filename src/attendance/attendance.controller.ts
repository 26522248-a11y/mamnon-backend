import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import * as fs from 'fs';
import { DataSource, In, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { dayDiff, todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { imageUploadOptions } from '../common/upload';
import { Attendance, AttendanceHistory, AttStatus, Child, Guardian, Pickup, PickupRequest } from '../database/entities';

export const TEACHER_EDIT_WINDOW_DAYS = 3;

export class AttendanceQuery {
  @ApiPropertyOptional({ example: '2026-10-09', description: 'Mặc định hôm nay (giờ VN)' }) @IsOptional() @IsDateString() date?: string;
}
class AttendanceItemDto {
  @ApiProperty() @IsUUID() childId!: string;
  @ApiProperty({ enum: ['present', 'absent', 'late'] }) @IsIn(['present', 'absent', 'late']) status!: AttStatus;
  @ApiPropertyOptional({ example: 'Ốm, mẹ xin nghỉ' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class PutAttendanceDto {
  @ApiProperty({ example: '2026-10-09' }) @IsDateString() date!: string;
  @ApiProperty({ type: [AttendanceItemDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AttendanceItemDto) items!: AttendanceItemDto[];
}
export class PickupDto {
  @ApiPropertyOptional({ description: 'Người đón nằm trong danh sách người giám hộ (canPickup=true)' }) @IsOptional() @IsUUID() guardianId?: string;
  @ApiPropertyOptional({ description: 'Người đón ngoài danh sách: yêu cầu đón đã được phụ huynh/BGH xác nhận' }) @IsOptional() @IsUUID() pickupRequestId?: string;
  @ApiPropertyOptional({ description: 'ISO 8601, mặc định thời điểm hiện tại' }) @IsOptional() @IsISO8601() pickedUpAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class CreatePickupRequestDto {
  @ApiProperty({ example: 'Nguyễn Văn Tư' }) @IsString() @MinLength(1) @MaxLength(120) pickerName!: string;
  @ApiProperty({ example: '0909123456' }) @Matches(/^[0-9+ ]{8,20}$/) pickerPhone!: string;
  @ApiPropertyOptional({ example: 'Chú ruột' }) @IsOptional() @IsString() @MaxLength(40) relation?: string;
  @ApiProperty({ example: 'Mẹ bé gọi báo nhờ chú đón' }) @IsString() @MinLength(1) @MaxLength(500) note!: string;
  @ApiPropertyOptional({ type: 'string', format: 'binary', description: 'Ảnh người đón (tuỳ chọn)' }) @IsOptional() photo?: any;
}
export class DecisionDto {
  @ApiPropertyOptional({ example: 'Đúng là chú của bé' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class PickupRequestQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] }) @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: string;
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
  id: p.id, attendanceId: p.attendanceId, guardianId: p.guardianId, pickupRequestId: p.pickupRequestId, pickedUpByName: p.pickedUpByName,
  relation: p.relation, pickedUpAt: p.pickedUpAt, isAuthorized: p.isAuthorized, note: p.note,
});
const requestView = (r: PickupRequest & { child?: Child }) => ({
  id: r.id, attendanceId: r.attendanceId, childId: r.childId, childName: r.child?.fullName, classId: r.classId,
  pickerName: r.pickerName, pickerPhone: r.pickerPhone, relation: r.relation, note: r.note, photoUrl: r.photoUrl,
  status: r.status, requestedBy: r.requestedBy, decidedBy: r.decidedBy, decidedByName: r.decider?.name ?? null,
  decidedAt: r.decidedAt, decisionNote: r.decisionNote, createdAt: r.createdAt,
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
    private access: AccessService, private ds: DataSource,
  ) {}

  private async sheet(classId: string, date: string) {
    const kids = await this.children.find({ where: { classId, status: 'active' }, order: { fullName: 'ASC' } });
    const rows = await this.att.find({ where: { classId, date }, relations: { pickup: true } });
    const byChild = new Map(rows.map((r) => [r.childId, r]));
    const extra = rows.filter((r) => !kids.some((k) => k.id === r.childId));
    const extraKids = extra.length ? await this.children.find({ where: { id: In(extra.map((r) => r.childId)) } }) : [];
    const pending = rows.length ? await this.requests.find({ where: { attendanceId: In(rows.map((r) => r.id)), status: 'pending' } }) : [];
    return [...kids, ...extraKids].map((k) => {
      const r = byChild.get(k.id);
      return {
        attendanceId: r?.id ?? null, childId: k.id, fullName: k.fullName, allergies: k.allergies ?? undefined,
        status: r?.status ?? null, note: r?.note ?? null, recorded: !!r,
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
    return { classId: id, date, items: await this.sheet(id, date) };
  }

  /** Bulk save. Every create/change is written to attendance_history (who, when, old → new). */
  @Put('classes/:id/attendance') @Roles('admin', 'teacher')
  async put(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutAttendanceDto) {
    await this.access.getClassOr404(id);
    this.access.assertOperateClass(u, id);
    assertDateEditable(u, dto.date);
    const ids = dto.items.map((i) => i.childId);
    if (new Set(ids).size !== ids.length) throw BadRequest('Trùng trẻ trong danh sách điểm danh');
    if (ids.length) {
      const kids = await this.children.find({ where: { id: In(ids) } });
      const bad = ids.filter((cid) => kids.find((k) => k.id === cid)?.classId !== id);
      if (bad.length) throw BadRequest(`Trẻ không thuộc lớp này: ${bad.join(', ')}`, 'CHILD_NOT_IN_CLASS');
    }
    await this.ds.transaction(async (m) => {
      const existing = ids.length
        ? await m.createQueryBuilder(Attendance, 'a').setLock('pessimistic_write')
            .where('a.child_id IN (:...ids)', { ids }).andWhere('a.date = :d', { d: dto.date }).getMany()
        : [];
      const byChild = new Map(existing.map((a) => [a.childId, a]));
      for (const i of dto.items) {
        const note = i.note ?? null;
        const old = byChild.get(i.childId);
        if (!old) {
          const a = await m.save(Attendance, m.create(Attendance, { childId: i.childId, classId: id, date: dto.date, status: i.status, note, recordedBy: u.id }));
          await m.save(AttendanceHistory, m.create(AttendanceHistory, { attendanceId: a.id, action: 'create', oldStatus: null, oldNote: null, newStatus: i.status, newNote: note, changedBy: u.id }));
        } else if (old.status !== i.status || (old.note ?? null) !== note) {
          await m.update(Attendance, old.id, { status: i.status, note, recordedBy: u.id, classId: id });
          await m.save(AttendanceHistory, m.create(AttendanceHistory, { attendanceId: old.id, action: 'update', oldStatus: old.status, oldNote: old.note, newStatus: i.status, newNote: note, changedBy: u.id }));
        }
      }
    });
    return { classId: id, date: dto.date, items: await this.sheet(id, dto.date) };
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
      attendanceId: id, childId: a.childId, date: a.date, current: { status: a.status, note: a.note },
      items: rows.map((h) => ({
        id: h.id, action: h.action, old: h.action === 'create' ? null : { status: h.oldStatus, note: h.oldNote },
        new: { status: h.newStatus, note: h.newNote },
        changedBy: h.changedBy, changedByName: h.changer?.name ?? null, changedByRole: h.changer?.role ?? null, changedAt: h.changedAt,
      })),
    };
  }

  /**
   * Hand the child over. Allowed only for (a) a listed guardian with canPickup=true, or
   * (b) a pickup request that the child's parent or admin has approved. Otherwise 403.
   */
  @Post('attendance/:id/pickup') @Roles('admin', 'teacher')
  async pickup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PickupDto) {
    const a = await this.attendanceForStaff(u, id);
    assertDateEditable(u, a.date);
    if (a.status === 'absent') throw BadRequest('Trẻ vắng mặt, không thể ghi nhận đón', 'CHILD_ABSENT');
    if (!!dto.guardianId === !!dto.pickupRequestId)
      throw BadRequest('Cần đúng một trong hai: guardianId (người trong danh sách) hoặc pickupRequestId (người ngoài danh sách đã được xác nhận)', 'PICKUP_PERSON_REQUIRED');

    let name: string, relation: string | null, guardianId: string | null = null, requestId: string | null = null;
    if (dto.guardianId) {
      const g = await this.guardians.findOne({ where: { id: dto.guardianId } });
      if (!g || g.childId !== a.childId) throw BadRequest('Người giám hộ không thuộc trẻ này', 'INVALID_GUARDIAN');
      if (!g.canPickup) throw new AppError(403, 'PICKUP_NOT_ALLOWED', 'Người này không được phép đón trẻ');
      guardianId = g.id; name = g.fullName; relation = g.relation;
    } else {
      const r = await this.requests.findOne({ where: { id: dto.pickupRequestId } });
      if (!r || r.attendanceId !== a.id) throw BadRequest('Yêu cầu đón không thuộc bản điểm danh này', 'INVALID_PICKUP_REQUEST');
      if (r.status === 'rejected') throw new AppError(403, 'PICKUP_REQUEST_REJECTED', 'Yêu cầu đón đã bị từ chối, không được giao trẻ');
      if (r.status !== 'approved') throw new AppError(403, 'PICKUP_REQUEST_PENDING', 'Yêu cầu đón chưa được phụ huynh hoặc Ban giám hiệu xác nhận');
      requestId = r.id; name = r.pickerName; relation = r.relation;
    }
    const existing = await this.pickups.findOne({ where: { attendanceId: id } });
    const p = await this.pickups.save({
      ...(existing ?? {}), attendanceId: id, guardianId, pickupRequestId: requestId, pickedUpByName: name, relation,
      pickedUpAt: dto.pickedUpAt ? new Date(dto.pickedUpAt) : new Date(), isAuthorized: true, note: dto.note ?? null, recordedBy: u.id,
    });
    return pickupView(p as Pickup);
  }

  /** Teacher registers a person NOT on the guardian list; child is released only after parent/admin confirms. */
  @Post('attendance/:id/pickup-requests') @Roles('admin', 'teacher')
  @ApiConsumes('multipart/form-data', 'application/json')
  @UseInterceptors(FileInterceptor('photo', imageUploadOptions))
  async createRequest(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePickupRequestDto,
    @UploadedFile() file?: Express.Multer.File) {
    const cleanup = () => file && fs.rm(file.path, () => undefined);
    try {
      const a = await this.attendanceForStaff(u, id);
      if (a.date !== todayStr()) throw BadRequest('Chỉ tạo yêu cầu đón cho ngày hôm nay', 'NOT_TODAY');
      if (a.status === 'absent') throw BadRequest('Trẻ vắng mặt, không thể tạo yêu cầu đón', 'CHILD_ABSENT');
      const r = await this.requests.save(this.requests.create({
        attendanceId: a.id, childId: a.childId, classId: a.classId, pickerName: dto.pickerName.trim(), pickerPhone: dto.pickerPhone,
        relation: dto.relation ?? null, note: dto.note, photoUrl: file ? `/uploads/${file.filename}` : null, status: 'pending', requestedBy: u.id,
      }));
      return requestView(r);
    } catch (e) { cleanup(); throw e; }
  }

  /** admin: all; teacher: own classes; parent: own children (e.g. ?status=pending). Accountant: 403. */
  @Get('pickup-requests') @Roles('admin', 'teacher', 'parent')
  async listRequests(@CurrentUser() u: AuthUser, @Query() q: PickupRequestQuery) {
    const qb = this.requests.createQueryBuilder('r').leftJoinAndSelect('r.child', 'c').leftJoinAndSelect('r.decider', 'd')
      .leftJoin('r.attendance', 'a').orderBy('r.createdAt', 'DESC').take(200);
    if (u.role === 'teacher') qb.andWhere('r.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('r.child_id = ANY(:kids)', { kids: u.childIds });
    if (q.status) qb.andWhere('r.status = :st', { st: q.status });
    if (q.childId) qb.andWhere('r.child_id = :cid', { cid: q.childId });
    if (q.date) qb.andWhere('a.date = :d', { d: q.date });
    return (await qb.getMany()).map(requestView);
  }

  private async decide(u: AuthUser, id: string, status: 'approved' | 'rejected', dto: DecisionDto) {
    const r = await this.requests.findOne({ where: { id } });
    if (!r) throw NotFound('Không tìm thấy yêu cầu đón');
    if (!(u.role === 'admin' || (u.role === 'parent' && u.childIds.includes(r.childId))))
      throw Forbidden('Chỉ phụ huynh của trẻ hoặc Ban giám hiệu được xác nhận');
    if (r.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', 'Yêu cầu này đã được xử lý');
    const res = await this.requests.createQueryBuilder().update().set({ status, decidedBy: u.id, decidedAt: () => 'now()', decisionNote: dto.note ?? null })
      .where('id = :id AND status = :p', { id, p: 'pending' }).execute();
    if (!res.affected) throw new AppError(409, 'ALREADY_DECIDED', 'Yêu cầu này đã được xử lý');
    return requestView((await this.requests.findOne({ where: { id }, relations: { child: true, decider: true } }))!);
  }

  @Post('pickup-requests/:id/confirm') @Roles('admin', 'parent') @HttpCode(200)
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) { return this.decide(u, id, 'approved', dto); }

  @Post('pickup-requests/:id/reject') @Roles('admin', 'parent') @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) { return this.decide(u, id, 'rejected', dto); }
}
