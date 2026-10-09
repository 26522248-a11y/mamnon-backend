import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { LoginThrottleService } from '../auth/login-throttle.service';
import { AuthUser, CurrentUser, Roles, UserContextService } from '../common/auth';
import { AppError, BadRequest, NotFound } from '../common/errors';
import { Role, ROLES, User } from '../database/entities';

export class CreateUserDto {
  @ApiProperty({ example: 'gv4' }) @IsString() @Matches(/^[a-z0-9_.]{3,64}$/, { message: 'username: 3-64 ký tự a-z, 0-9, _ .' }) username!: string;
  @ApiProperty({ example: '123456', minLength: 6 }) @IsString() @MinLength(6) @MaxLength(128) password!: string;
  @ApiProperty({ example: 'Cô Thảo' }) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role!: Role;
  @ApiPropertyOptional({ example: '0901000004' }) @IsOptional() @Matches(/^[0-9+ ]{8,20}$/) phone?: string;
}
export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9+ ]{8,20}$/) phone?: string;
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class ResetPasswordDto { @ApiProperty({ minLength: 6 }) @IsString() @MinLength(6) @MaxLength(128) newPassword!: string; }
export class UserQuery {
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ enum: ['true', 'false', 'all'], default: 'all' }) @IsOptional() @IsIn(['true', 'false', 'all']) active?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** Admin-only account management. Password hashes are never returned. */
@ApiTags('users') @ApiBearerAuth()
@Controller('users') @Roles('admin')
export class UsersController {
  constructor(
    @InjectRepository(User) private users: Repository<User>, private ctx: UserContextService, private ds: DataSource,
    private throttle: LoginThrottleService,
  ) {}

  private async view(u: User) {
    const c = await this.ctx.build(u);
    const lockedUntil = this.throttle.lockedUntil(u.username);
    return { id: u.id, username: u.username, name: u.name, role: u.role, phone: u.phone, isActive: u.isActive, mustChangePassword: u.mustChangePassword,
      locked: !!lockedUntil, lockedUntil: lockedUntil?.toISOString() ?? null,
      classIds: c.classIds, childIds: c.childIds, createdAt: u.createdAt, updatedAt: u.updatedAt };
  }
  private async getOr404(id: string) {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw NotFound('Không tìm thấy tài khoản');
    return u;
  }
  /** Prevent locking the school out: there must remain at least one active admin. */
  private async assertNotLastAdmin(target: User) {
    if (target.role !== 'admin' || !target.isActive) return;
    if ((await this.users.count({ where: { role: 'admin', isActive: true } })) <= 1)
      throw new AppError(409, 'LAST_ADMIN', 'Không thể khoá/đổi vai trò/xoá admin cuối cùng');
  }

  @Get()
  async list(@Query() q: UserQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const qb = this.users.createQueryBuilder('u');
    if (q.role) qb.andWhere('u.role = :r', { r: q.role });
    if ((q.active ?? 'all') !== 'all') qb.andWhere('u.is_active = :a', { a: q.active === 'true' });
    if (q.search?.trim()) qb.andWhere('(unaccent(u.name) ILIKE unaccent(:s) OR u.username ILIKE :s OR u.phone ILIKE :s)', { s: `%${q.search.trim().replace(/[%_\\]/g, '\\$&')}%` });
    qb.orderBy('u.role').addOrderBy('u.username').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { items: await Promise.all(rows.map((u) => this.view(u))), page, limit, total };
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) { return this.view(await this.getOr404(id)); }

  @Post()
  async create(@Body() dto: CreateUserDto) {
    if (await this.users.exist({ where: { username: dto.username } })) throw new AppError(409, 'USERNAME_TAKEN', 'Tên đăng nhập đã tồn tại');
    const u = await this.users.save(this.users.create({ username: dto.username, name: dto.name, role: dto.role, phone: dto.phone ?? null,
      passwordHash: await bcrypt.hash(dto.password, 10), mustChangePassword: true }));
    return this.view(u);
  }

  @Patch(':id')
  async update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    const u = await this.getOr404(id);
    const roleChange = dto.role !== undefined && dto.role !== u.role;
    const deactivate = dto.isActive === false && u.isActive;
    if (u.id === me.id && (roleChange || deactivate)) throw BadRequest('Không thể tự đổi vai trò hoặc tự khoá tài khoản của mình', 'SELF_CHANGE');
    if (roleChange || deactivate) await this.assertNotLastAdmin(u);
    if (roleChange) {
      const c = await this.ctx.build(u);
      if (c.classIds.length || c.childIds.length)
        throw new AppError(409, 'USER_HAS_LINKS', 'Tài khoản đang gắn với lớp/trẻ; gỡ liên kết trước khi đổi vai trò');
    }
    Object.assign(u, dto);
    if (roleChange || deactivate) u.tokenVersion += 1; // kick existing sessions
    return this.view(await this.users.save(u));
  }

  @Post(':id/reset-password') @HttpCode(200)
  async resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto) {
    const u = await this.getOr404(id);
    u.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    u.tokenVersion += 1;
    u.mustChangePassword = true;
    await this.users.save(u);
    this.throttle.clearUser(u.username); // also unlocks login
    return { id, ok: true, mustChangePassword: true };
  }

  /** Clears the failed-login lock of this account (all IPs). IP-wide locks (30 failures from one IP) expire on their own. */
  @Post(':id/unlock') @HttpCode(200)
  async unlock(@Param('id', ParseUUIDPipe) id: string) {
    const u = await this.getOr404(id);
    const was = this.throttle.lockedUntil(u.username);
    this.throttle.clearUser(u.username);
    return { id, username: u.username, wasLocked: !!was, previousLockedUntil: was?.toISOString() ?? null, locked: false, lockedUntil: null };
  }

  @Post(':id/deactivate') @HttpCode(200)
  async deactivate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.update(me, id, { isActive: false }); }

  @Post(':id/activate') @HttpCode(200)
  async activate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.update(me, id, { isActive: true }); }

  /** Hard delete only for accounts without any history; otherwise deactivate (keeps audit trail). */
  @Delete(':id') @HttpCode(204)
  async remove(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const u = await this.getOr404(id);
    if (u.id === me.id) throw BadRequest('Không thể tự xoá tài khoản của mình', 'SELF_CHANGE');
    await this.assertNotLastAdmin(u);
    const [{ n }] = await this.ds.query(`SELECT (
        (SELECT COUNT(*) FROM attendance_history WHERE changed_by = $1) + (SELECT COUNT(*) FROM attendance WHERE recorded_by = $1)
      + (SELECT COUNT(*) FROM payments WHERE received_by = $1) + (SELECT COUNT(*) FROM invoices WHERE created_by = $1)
      + (SELECT COUNT(*) FROM announcements WHERE created_by = $1) + (SELECT COUNT(*) FROM pickup_requests WHERE requested_by = $1 OR decided_by = $1)
      + (SELECT COUNT(*) FROM guardians WHERE user_id = $1))::int AS n`, [id]);
    if (n > 0) throw new AppError(409, 'USER_HAS_HISTORY', 'Tài khoản đã có dữ liệu liên quan; hãy khoá (deactivate) thay vì xoá');
    await this.users.delete(id);
  }
}
