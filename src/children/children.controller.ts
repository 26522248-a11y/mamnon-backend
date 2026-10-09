import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Request, Response } from 'express';
import { Between, DataSource, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { recordAudit } from '../common/audit';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { Attendance, Child, ClassRoom, Guardian, User } from '../database/entities';
import { addDays, todayStr } from '../common/dates';
import { imageUploadOptions, removeImage, saveImage, sendImage } from '../common/upload';

export class ListChildrenQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 10, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ description: 'Tìm theo tên, không phân biệt dấu' }) @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: ['active', 'withdrawn', 'all'], default: 'active', description: "'left' vẫn được chấp nhận = withdrawn" }) @IsOptional() @IsIn(['active', 'withdrawn', 'left', 'all']) status?: string;
}
export class CreateChildDto {
  @ApiProperty({ example: 'Nguyễn Gia An' }) @IsString() @MinLength(1) @MaxLength(120) fullName!: string;
  @ApiProperty({ example: '2022-05-14' }) @IsDateString() dob!: string;
  @ApiProperty({ enum: ['M', 'F'] }) @IsIn(['M', 'F']) gender!: 'M' | 'F';
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ example: 'Đậu phộng' }) @IsOptional() @IsString() @MaxLength(500) allergies?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) healthNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiPropertyOptional({ example: '2025-09-05' }) @IsOptional() @IsDateString() enrolledAt?: string;
}
export class UpdateChildDto extends PartialType(CreateChildDto) {}
class ParentAccountDto {
  @ApiProperty({ example: 'ph_an' }) @IsString() @Matches(/^[a-z0-9_.]{3,64}$/) username!: string;
  @ApiProperty({ example: '123456' }) @IsString() @MinLength(6) @MaxLength(128) password!: string;
}
export class CreateGuardianDto {
  @ApiProperty({ example: 'Nguyễn Văn Bình' }) @IsString() @MinLength(1) @MaxLength(120) fullName!: string;
  @ApiProperty({ example: 'Bố' }) @IsString() @MaxLength(40) relation!: string;
  @ApiPropertyOptional({ example: '0901234567' }) @IsOptional() @Matches(/^[0-9+ ]{8,20}$/) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) idNumber?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() canPickup?: boolean;
  @ApiPropertyOptional({ description: 'Liên kết với tài khoản phụ huynh có sẵn' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ type: ParentAccountDto, description: 'Tạo mới tài khoản phụ huynh (nhà trường cấp)' })
  @IsOptional() @ValidateNested() @Type(() => ParentAccountDto) account?: ParentAccountDto;
}
export class RemoveGuardianDto {
  @ApiProperty({ example: 'Nhập Excel gắn nhầm SĐT của người khác' }) @IsString() @Matches(/\S/, { message: 'reason không được để trống' }) @MaxLength(500) reason!: string;
}
export class AttendanceSummaryQuery {
  @ApiProperty({ example: '2026-10', description: 'Tháng YYYY-MM' }) @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 300 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(300) limit?: number;
}
export class ChildAttendanceQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, mặc định 30 ngày trước' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, mặc định hôm nay' }) @IsOptional() @IsDateString() to?: string;
}


@ApiTags('children') @ApiBearerAuth()
@Controller('children')
export class ChildrenController {
  constructor(
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(Guardian) private guardians: Repository<Guardian>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(ClassRoom) private classes: Repository<ClassRoom>,
    @InjectRepository(Attendance) private attendance: Repository<Attendance>,
    private access: AccessService, private ds: DataSource,
  ) {}

  /** Accountant only gets name + class (no health data). */
  private view(u: AuthUser, c: Child) {
    const base = { id: c.id, fullName: c.fullName, classId: c.classId, className: c.classRoom?.name ?? null, status: c.status, leaveDate: c.leaveDate };
    if (u.role === 'accountant') return base;
    return {
      ...base, dob: c.dob, gender: c.gender, allergies: c.allergies ?? undefined, healthNotes: c.healthNotes,
      address: c.address, photoUrl: c.photoUrl ? `/api/v1/children/${c.id}/photo` : null, enrolledAt: c.enrolledAt,
    };
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: ListChildrenQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 10;
    const qb = this.children.createQueryBuilder('c').leftJoinAndSelect('c.classRoom', 'cl');
    if (u.role === 'teacher') qb.andWhere('c.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('c.id = ANY(:kids)', { kids: u.childIds });
    if (q.classId) qb.andWhere('c.class_id = :classId', { classId: q.classId });
    if ((q.status ?? 'active') !== 'all') qb.andWhere('c.status = :st', { st: q.status === 'left' ? 'withdrawn' : q.status ?? 'active' });
    if (q.search?.trim()) qb.andWhere('unaccent(c.full_name) ILIKE unaccent(:s)', { s: `%${q.search.trim().replace(/[%_\\]/g, '\\$&')}%` });
    qb.orderBy('cl.name', 'ASC', 'NULLS LAST').addOrderBy('c.fullName', 'ASC').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((c) => this.view(u, c)), page, limit, total };
  }

  /**
   * Monthly day counts per child (no daily detail). Accountant uses this for meal-fee calculation.
   * Scope: admin/accountant all, teacher own classes, parent own children.
   */
  @Get('attendance-summary')
  async attendanceSummary(@CurrentUser() u: AuthUser, @Query() q: AttendanceSummaryQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 50;
    const from = `${q.month}-01`;
    const [y, m] = q.month.split('-').map(Number);
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const qb = this.children.createQueryBuilder('c').leftJoinAndSelect('c.classRoom', 'cl').where("c.status = 'active'");
    if (u.role === 'teacher') qb.andWhere('c.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('c.id = ANY(:kids)', { kids: u.childIds });
    if (q.classId) qb.andWhere('c.class_id = :classId', { classId: q.classId });
    qb.orderBy('cl.name', 'ASC', 'NULLS LAST').addOrderBy('c.fullName', 'ASC').skip((page - 1) * limit).take(limit);
    const [kids, total] = await qb.getManyAndCount();
    const counts: { child_id: string; present: string; late: string; absent: string }[] = kids.length
      ? await this.attendance.createQueryBuilder('a').select('a.child_id', 'child_id')
          .addSelect("COUNT(*) FILTER (WHERE a.status = 'present')", 'present')
          .addSelect("COUNT(*) FILTER (WHERE a.status = 'late')", 'late')
          .addSelect("COUNT(*) FILTER (WHERE a.status = 'absent')", 'absent')
          .where('a.child_id IN (:...ids)', { ids: kids.map((k) => k.id) }).andWhere('a.date BETWEEN :from AND :to', { from, to })
          .groupBy('a.child_id').getRawMany()
      : [];
    return {
      month: q.month, from, to, page, limit, total,
      items: kids.map((k) => {
        const c = counts.find((x) => x.child_id === k.id);
        const present = Number(c?.present ?? 0), late = Number(c?.late ?? 0), absent = Number(c?.absent ?? 0);
        return { childId: k.id, fullName: k.fullName, classId: k.classId, className: k.classRoom?.name ?? null,
          attendedDays: present + late, presentDays: present, lateDays: late, absentDays: absent, recordedDays: present + late + absent };
      }),
    };
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.view(u, await this.access.assertChildRead(u, id));
  }

  private async checkClass(classId?: string | null) {
    if (classId && !(await this.classes.exist({ where: { id: classId } }))) throw BadRequest('Lớp không tồn tại', 'INVALID_CLASS');
  }

  @Post() @Roles('admin')
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateChildDto) {
    await this.checkClass(dto.classId);
    const c = await this.children.save(this.children.create({ ...dto, classId: dto.classId ?? null }));
    return this.view(u, await this.access.getChildOr404(c.id));
  }

  /** Admin: all fields. Teacher of the class: only allergies / healthNotes. */
  @Patch(':id') @Roles('admin', 'teacher')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChildDto) {
    const c = await this.access.getChildOr404(id);
    if (u.role === 'teacher') {
      if (!this.access.canOperateClass(u, c.classId)) throw Forbidden('Không có quyền với trẻ này');
      const extra = Object.keys(dto).filter((k) => !['allergies', 'healthNotes'].includes(k));
      if (extra.length) throw Forbidden('Giáo viên chỉ được sửa dị ứng và ghi chú sức khoẻ');
    }
    await this.checkClass(dto.classId);
    const { classRoom, ...rest } = c as any;
    await this.children.save({ ...rest, ...dto });
    return this.view(u, await this.access.getChildOr404(id));
  }

  @Delete(':id') @Roles('admin') @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.access.getChildOr404(id);
    await this.children.delete(id);
    removeImage(c.photoUrl);
  }

  @Post(':id/photo') @Roles('admin', 'teacher')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary', description: 'JPG/PNG ≤ 3MB (kiểm tra nội dung thật)' } } } })
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  async photo(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) {
    const c = await this.access.getChildOr404(id);
    if (!this.access.canOperateClass(u, c.classId)) throw Forbidden('Không có quyền với trẻ này');
    const key = await saveImage(file); // 400 INVALID_FILE unless real JPEG/PNG/HEIC
    await this.children.update(id, { photoUrl: key });
    removeImage(c.photoUrl);
    return { photoUrl: `/api/v1/children/${id}/photo` };
  }

  /** Photo bytes; same rule as child detail: admin, teacher of the class, parent of the child (accountant 403). */
  @Get(':id/photo')
  async getPhoto(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const c = await this.access.assertChildRead(u, id, true);
    sendImage(res, c.photoUrl);
  }

  @Get(':id/guardians')
  async listGuardians(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertChildRead(u, id, true);
    const gs = await this.guardians.find({ where: { childId: id }, relations: { user: true }, order: { createdAt: 'ASC' } });
    return gs.map((g) => ({
      id: g.id, childId: g.childId, fullName: g.fullName, relation: g.relation, phone: g.phone, idNumber: g.idNumber,
      canPickup: g.canPickup, userId: g.userId, username: g.user?.username ?? null,
    }));
  }

  @Post(':id/guardians') @Roles('admin')
  async addGuardian(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateGuardianDto) {
    await this.access.getChildOr404(id);
    if (dto.userId && dto.account) throw BadRequest('Chỉ chọn userId hoặc account, không chọn cả hai');
    return this.ds.transaction(async (m) => {
      let userId: string | null = null;
      if (dto.userId) {
        const pu = await m.findOne(User, { where: { id: dto.userId } });
        if (!pu) throw NotFound('Không tìm thấy tài khoản');
        if (pu.role !== 'parent') throw BadRequest('Tài khoản không phải phụ huynh', 'NOT_A_PARENT');
        userId = pu.id;
      } else if (dto.account) {
        if (await m.exists(User, { where: { username: dto.account.username } })) throw new AppError(409, 'USERNAME_TAKEN', 'Tên đăng nhập đã tồn tại');
        const pu = await m.save(User, m.create(User, {
          username: dto.account.username, passwordHash: await bcrypt.hash(dto.account.password, 10),
          name: dto.fullName, role: 'parent', phone: dto.phone ?? null, mustChangePassword: true,
        }));
        userId = pu.id;
      }
      const { account, ...rest } = dto;
      const g = await m.save(Guardian, m.create(Guardian, { ...rest, childId: id, userId, canPickup: dto.canPickup ?? true }));
      return { ...g, username: dto.account?.username ?? null };
    });
  }

  /**
   * Remove a guardian from a child (admin). Deletes the guardian record, so its parent account (if any) immediately loses
   * access to this child (parent access = guardians.user_id, re-read on every request). The account itself is kept,
   * even when it has no child left (reported as accountHasNoChildren). Audit-logged with the reason.
   */
  @Delete(':id/guardians/:guardianId') @Roles('admin') @HttpCode(200)
  async removeGuardian(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('guardianId', ParseUUIDPipe) guardianId: string, @Body() dto: RemoveGuardianDto, @Req() req: Request) {
    const child = await this.access.getChildOr404(id);
    return this.ds.transaction(async (m) => {
      const g = await m.findOne(Guardian, { where: { id: guardianId, childId: id }, relations: { user: true }, lock: { mode: 'pessimistic_write', tables: ['guardians'] } });
      if (!g) throw NotFound('Không tìm thấy người giám hộ của trẻ này');
      await m.delete(Guardian, { id: g.id });
      let account: { userId: string; username: string; name: string; remainingChildren: string[]; accountHasNoChildren: boolean } | null = null;
      if (g.userId) {
        const rest: { full_name: string }[] = await m.query(
          `SELECT DISTINCT c.full_name FROM guardians gg JOIN children c ON c.id = gg.child_id WHERE gg.user_id = $1 ORDER BY c.full_name`, [g.userId]);
        account = { userId: g.userId, username: g.user?.username ?? '', name: g.user?.name ?? '', remainingChildren: rest.map((x) => x.full_name), accountHasNoChildren: rest.length === 0 };
      }
      const result = {
        removed: { guardianId: g.id, childId: id, childName: child.fullName, fullName: g.fullName, relation: g.relation, phone: g.phone, canPickup: g.canPickup },
        account, reason: dto.reason.trim(),
      };
      await recordAudit(m, u, { action: 'guardian.remove', entityType: 'guardian', entityId: g.id, childId: id, before: result.removed, after: null,
        reason: result.reason, ip: req.ip ?? null, data: { account, removed: result.removed } }); // 'removed' kept for the jsonl format of 4ff7386
      return result;
    });
  }

  @Get(':id/attendance')
  async childAttendance(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ChildAttendanceQuery) {
    await this.access.assertChildRead(u, id, true);
    const to = q.to ?? todayStr(), from = q.from ?? addDays(to, -30);
    const rows = await this.attendance.find({ where: { childId: id, date: Between(from, to) }, relations: { pickup: true }, order: { date: 'DESC' } });
    return rows.map((a) => ({
      id: a.id, date: a.date, status: a.status, note: a.note,
      pickup: a.pickup ? { pickedUpByName: a.pickup.pickedUpByName, relation: a.pickup.relation, pickedUpAt: a.pickup.pickedUpAt } : null,
    }));
  }
}
