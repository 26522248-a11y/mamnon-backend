import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { diskStorage } from 'multer';
import * as path from 'path';
import { Between, DataSource, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { Attendance, Child, ClassRoom, Guardian, User } from '../database/entities';
import { addDays, todayStr } from '../common/dates';

export class ListChildrenQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 10, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ description: 'Tìm theo tên, không phân biệt dấu' }) @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: ['active', 'left', 'all'], default: 'active' }) @IsOptional() @IsIn(['active', 'left', 'all']) status?: string;
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
  @ApiPropertyOptional({ enum: ['active', 'left'] }) @IsOptional() @IsIn(['active', 'left']) status?: 'active' | 'left';
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
export class ChildAttendanceQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, mặc định 30 ngày trước' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, mặc định hôm nay' }) @IsOptional() @IsDateString() to?: string;
}

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

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
    const base = { id: c.id, fullName: c.fullName, classId: c.classId, className: c.classRoom?.name ?? null, status: c.status };
    if (u.role === 'accountant') return base;
    return {
      ...base, dob: c.dob, gender: c.gender, allergies: c.allergies ?? undefined, healthNotes: c.healthNotes,
      address: c.address, photoUrl: c.photoUrl, enrolledAt: c.enrolledAt,
    };
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: ListChildrenQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 10;
    const qb = this.children.createQueryBuilder('c').leftJoinAndSelect('c.classRoom', 'cl');
    if (u.role === 'teacher') qb.andWhere('c.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('c.id = ANY(:kids)', { kids: u.childIds });
    if (q.classId) qb.andWhere('c.class_id = :classId', { classId: q.classId });
    if ((q.status ?? 'active') !== 'all') qb.andWhere('c.status = :st', { st: q.status ?? 'active' });
    if (q.search?.trim()) qb.andWhere('unaccent(c.full_name) ILIKE unaccent(:s)', { s: `%${q.search.trim().replace(/[%_\\]/g, '\\$&')}%` });
    qb.orderBy('cl.name', 'ASC', 'NULLS LAST').addOrderBy('c.fullName', 'ASC').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((c) => this.view(u, c)), page, limit, total };
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
    if (c.photoUrl) fs.rm(path.join(UPLOAD_DIR, path.basename(c.photoUrl)), () => undefined);
  }

  @Post(':id/photo') @Roles('admin', 'teacher')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
    }),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => /^image\/(jpeg|png|webp)$/.test(file.mimetype)
      ? cb(null, true) : cb(new AppError(400, 'INVALID_FILE', 'Chỉ nhận ảnh JPG, PNG hoặc WEBP'), false),
  }))
  async photo(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) {
    const c = await this.access.getChildOr404(id);
    if (!this.access.canOperateClass(u, c.classId)) { if (file) fs.rm(file.path, () => undefined); throw Forbidden('Không có quyền với trẻ này'); }
    if (!file) throw BadRequest('Thiếu file ảnh (field "file")', 'INVALID_FILE');
    if (c.photoUrl) fs.rm(path.join(UPLOAD_DIR, path.basename(c.photoUrl)), () => undefined);
    await this.children.update(id, { photoUrl: `/uploads/${file.filename}` });
    return { photoUrl: `/uploads/${file.filename}` };
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
          name: dto.fullName, role: 'parent', phone: dto.phone ?? null,
        }));
        userId = pu.id;
      }
      const { account, ...rest } = dto;
      const g = await m.save(Guardian, m.create(Guardian, { ...rest, childId: id, userId, canPickup: dto.canPickup ?? true }));
      return { ...g, username: dto.account?.username ?? null };
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
