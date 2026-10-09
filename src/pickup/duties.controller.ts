import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DataSource, In } from 'typeorm';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { addDays, todayStr } from '../common/dates';
import { BadRequest, NotFound } from '../common/errors';
import { PickupDuty, User } from '../database/entities';
import { audit } from '../common/audit';

export class AssignDutyDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty({ type: [String], example: ['2026-10-12', '2026-10-13'] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(366) @IsDateString({}, { each: true }) dates!: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}
export class DutyQuery {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
}
const view = (d: PickupDuty) => ({ id: d.id, date: d.date, userId: d.userId, userName: d.user?.name ?? null, userRole: d.user?.role ?? null, assignedBy: d.assignedBy, note: d.note, createdAt: d.createdAt });

/** Lịch trực đón: the duty account may give the school approval of off-list pickup requests, only on its dates. Admin assigns. */
@ApiTags('pickup-safety') @ApiBearerAuth()
@Controller('pickup-duties')
export class PickupDutiesController {
  constructor(private ds: DataSource) {}

  @Post() @Roles('admin')
  async assign(@CurrentUser() u: AuthUser, @Body() dto: AssignDutyDto) {
    const user = await this.ds.getRepository(User).findOne({ where: { id: dto.userId } });
    if (!user) throw NotFound('Không tìm thấy người dùng');
    if (user.role === 'parent' || !user.isActive) throw BadRequest('Chỉ chỉ định tài khoản nhân viên đang hoạt động', 'INVALID_DUTY_USER');
    const dates = [...new Set(dto.dates.map((d) => d.slice(0, 10)))];
    await this.ds.createQueryBuilder().insert().into(PickupDuty).values(dates.map((date) => ({ date, userId: user.id, assignedBy: u.id, note: dto.note ?? null })))
      .orIgnore().execute();
    const rows = await this.ds.getRepository(PickupDuty).find({ where: { userId: user.id, date: In(dates) }, relations: { user: true }, order: { date: 'ASC' } });
    audit('pickup_duty.assign', u, { userId: user.id, username: user.username, dates, note: dto.note ?? null });
    return rows.map(view);
  }

  /** admin: everyone; other staff: own duties only. Default: today .. +30 days. */
  @Get() @Roles('admin', 'teacher', 'accountant')
  async list(@CurrentUser() u: AuthUser, @Query() q: DutyQuery) {
    const from = q.from ?? todayStr(), to = q.to ?? addDays(from, 30);
    const qb = this.ds.getRepository(PickupDuty).createQueryBuilder('d').leftJoinAndSelect('d.user', 'u').where('d.date BETWEEN :from AND :to', { from, to }).orderBy('d.date', 'ASC');
    if (u.role !== 'admin') qb.andWhere('d.user_id = :me', { me: u.id });
    else if (q.userId) qb.andWhere('d.user_id = :uid', { uid: q.userId });
    return (await qb.getMany()).map(view);
  }

  @Get('me') @Roles('admin', 'teacher', 'accountant')
  async me(@CurrentUser() u: AuthUser) {
    const today = todayStr();
    const rows = await this.ds.getRepository(PickupDuty).createQueryBuilder('d').where('d.user_id = :me AND d.date >= :today', { me: u.id, today }).orderBy('d.date', 'ASC').take(60).getMany();
    return { today, onDutyToday: rows.some((r) => r.date === today), canApproveToday: u.role === 'admin' || rows.some((r) => r.date === today), upcoming: rows.map((r) => r.date) };
  }

  @Delete(':id') @Roles('admin') @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.ds.getRepository(PickupDuty).findOne({ where: { id } });
    if (!d) throw NotFound('Không tìm thấy lịch trực');
    await this.ds.getRepository(PickupDuty).delete(id);
    audit('pickup_duty.remove', u, { dutyId: id, userId: d.userId, date: d.date });
  }
}
