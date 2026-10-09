import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { DataSource, In, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { dayDiff, todayStr } from '../common/dates';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { Attendance, AttStatus, Child, Guardian, Pickup } from '../database/entities';

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
  @ApiPropertyOptional({ description: 'Người đón nằm trong danh sách người giám hộ' }) @IsOptional() @IsUUID() guardianId?: string;
  @ApiPropertyOptional({ description: 'Bắt buộc nếu không có guardianId' }) @IsOptional() @IsString() @MinLength(1) @MaxLength(120) pickedUpByName?: string;
  @ApiPropertyOptional({ example: 'Bà ngoại' }) @IsOptional() @IsString() @MaxLength(40) relation?: string;
  @ApiPropertyOptional({ description: 'ISO 8601, mặc định thời điểm hiện tại' }) @IsOptional() @IsISO8601() pickedUpAt?: string;
  @ApiPropertyOptional({ description: 'Bắt buộc nếu người đón không có trong danh sách' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Teacher: today and up to 3 days back. Admin: any past date. Nobody: future dates. */
function assertDateEditable(u: AuthUser, date: string) {
  const diff = dayDiff(todayStr(), date);
  if (diff < 0) throw BadRequest('Không thể ghi điểm danh cho ngày trong tương lai', 'DATE_IN_FUTURE');
  if (u.role !== 'admin' && diff > TEACHER_EDIT_WINDOW_DAYS)
    throw new AppError(403, 'EDIT_WINDOW_EXPIRED', `Giáo viên chỉ được sửa điểm danh trong ${TEACHER_EDIT_WINDOW_DAYS} ngày gần nhất; liên hệ Ban giám hiệu`);
}

@ApiTags('attendance') @ApiBearerAuth()
@Controller()
export class AttendanceController {
  constructor(
    @InjectRepository(Attendance) private att: Repository<Attendance>,
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(Guardian) private guardians: Repository<Guardian>,
    @InjectRepository(Pickup) private pickups: Repository<Pickup>,
    private access: AccessService, private ds: DataSource,
  ) {}

  private async sheet(classId: string, date: string) {
    const kids = await this.children.find({ where: { classId, status: 'active' }, order: { fullName: 'ASC' } });
    const rows = await this.att.find({ where: { classId, date }, relations: { pickup: true } });
    const byChild = new Map(rows.map((r) => [r.childId, r]));
    // include children recorded in this class that day but since moved
    const extra = rows.filter((r) => !kids.some((k) => k.id === r.childId));
    const extraKids = extra.length ? await this.children.find({ where: { id: In(extra.map((r) => r.childId)) } }) : [];
    return [...kids, ...extraKids].map((k) => {
      const r = byChild.get(k.id);
      return {
        attendanceId: r?.id ?? null, childId: k.id, fullName: k.fullName, allergies: k.allergies ?? undefined,
        status: r?.status ?? null, note: r?.note ?? null, recorded: !!r,
        pickup: r?.pickup ? { id: r.pickup.id, guardianId: r.pickup.guardianId, pickedUpByName: r.pickup.pickedUpByName, relation: r.pickup.relation, pickedUpAt: r.pickup.pickedUpAt, isAuthorized: r.pickup.isAuthorized, note: r.pickup.note } : null,
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
      for (const i of dto.items) {
        await m.createQueryBuilder().insert().into(Attendance)
          .values({ childId: i.childId, classId: id, date: dto.date, status: i.status, note: i.note ?? null, recordedBy: u.id })
          .orUpdate(['status', 'note', 'recorded_by', 'class_id', 'updated_at'], ['child_id', 'date']).execute();
      }
    });
    return { classId: id, date: dto.date, items: await this.sheet(id, dto.date) };
  }

  @Post('attendance/:id/pickup') @Roles('admin', 'teacher')
  async pickup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PickupDto) {
    const a = await this.att.findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy bản ghi điểm danh');
    this.access.assertOperateClass(u, a.classId);
    assertDateEditable(u, a.date);
    if (a.status === 'absent') throw BadRequest('Trẻ vắng mặt, không thể ghi nhận đón', 'CHILD_ABSENT');

    let name = dto.pickedUpByName?.trim(), relation = dto.relation ?? null, guardianId: string | null = null, authorized = false;
    if (dto.guardianId) {
      const g = await this.guardians.findOne({ where: { id: dto.guardianId } });
      if (!g || g.childId !== a.childId) throw BadRequest('Người giám hộ không thuộc trẻ này', 'INVALID_GUARDIAN');
      if (!g.canPickup) throw new AppError(403, 'PICKUP_NOT_ALLOWED', 'Người này không được phép đón trẻ');
      guardianId = g.id; name = g.fullName; relation = relation ?? g.relation; authorized = true;
    } else {
      // Pending PM decision: unlisted person is allowed but must be named + noted, flagged isAuthorized=false.
      if (!name) throw BadRequest('Cần guardianId hoặc pickedUpByName', 'PICKUP_PERSON_REQUIRED');
      if (!dto.note?.trim()) throw BadRequest('Người đón không có trong danh sách: bắt buộc ghi chú (vd. đã gọi xác nhận phụ huynh)', 'NOTE_REQUIRED');
    }
    const existing = await this.pickups.findOne({ where: { attendanceId: id } });
    const p = await this.pickups.save({
      ...(existing ?? {}), attendanceId: id, guardianId, pickedUpByName: name!, relation,
      pickedUpAt: dto.pickedUpAt ? new Date(dto.pickedUpAt) : new Date(), isAuthorized: authorized, note: dto.note ?? null, recordedBy: u.id,
    });
    return { id: p.id, attendanceId: id, guardianId, pickedUpByName: p.pickedUpByName, relation: p.relation, pickedUpAt: p.pickedUpAt, isAuthorized: p.isAuthorized, note: p.note };
  }
}
