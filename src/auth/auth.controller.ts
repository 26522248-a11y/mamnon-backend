import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiCookieAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Public, UserContextService } from '../common/auth';
import { AppError } from '../common/errors';
import { User } from '../database/entities';
import { LoginThrottleService } from './login-throttle.service';

export class LoginDto {
  @ApiProperty({ example: 'admin' }) @IsString() @MinLength(1) @MaxLength(64) username!: string;
  @ApiProperty({ example: '123456' }) @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
export class ChangePasswordDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
  @ApiProperty({ minLength: 6 }) @IsString() @MinLength(6) @MaxLength(128) newPassword!: string;
}
class UserView {
  @ApiProperty() id!: string; @ApiProperty() username!: string; @ApiProperty() name!: string;
  @ApiProperty({ enum: ['admin', 'teacher', 'accountant', 'parent'] }) role!: string;
  @ApiProperty({ type: [String] }) classIds!: string[]; @ApiProperty({ type: [String] }) childIds!: string[];
}
class TokenResponse {
  @ApiProperty() accessToken!: string; @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ example: '15m' }) expiresIn!: string; @ApiProperty({ type: UserView }) user!: UserView;
}

export const REFRESH_COOKIE = 'refresh_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @InjectRepository(User) private users: Repository<User>, private jwt: JwtService, private ctx: UserContextService,
    private throttle: LoginThrottleService,
  ) {}

  private async issue(user: User, res: Response): Promise<TokenResponse> {
    const accessTtl = process.env.JWT_ACCESS_TTL || '15m';
    const refreshTtl = process.env.JWT_REFRESH_TTL || '7d';
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role, ver: user.tokenVersion, typ: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: accessTtl });
    const refresh = await this.jwt.signAsync({ sub: user.id, ver: user.tokenVersion, typ: 'refresh' },
      { secret: process.env.JWT_REFRESH_SECRET, expiresIn: refreshTtl });
    const decoded: any = this.jwt.decode(refresh);
    res.cookie(REFRESH_COOKIE, refresh, {
      httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true',
      path: '/api/v1/auth', expires: new Date(decoded.exp * 1000),
    });
    return { accessToken, tokenType: 'Bearer', expiresIn: accessTtl, user: await this.ctx.build(user) };
  }

  @Public() @Post('login') @HttpCode(200)
  @ApiOkResponse({ type: TokenResponse, description: 'Access token trong body, refresh token trong cookie httpOnly `refresh_token`' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const username = dto.username.trim().toLowerCase(), ip = req.ip || 'unknown';
    this.throttle.assertAllowed(username, ip); // 429 TOO_MANY_ATTEMPTS while locked
    const user = await this.users.findOne({ where: { username } });
    if (!user || !user.isActive || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      this.throttle.recordFailure(username, ip);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu');
    }
    this.throttle.recordSuccess(username, ip);
    return this.issue(user, res);
  }

  @Public() @Post('refresh') @HttpCode(200) @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOkResponse({ type: TokenResponse, description: 'Đổi refresh token (cookie) lấy access token mới; cookie được xoay vòng' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new AppError(401, 'NO_REFRESH_TOKEN', 'Thiếu refresh token');
    let p: any;
    try { p = await this.jwt.verifyAsync(token, { secret: process.env.JWT_REFRESH_SECRET }); }
    catch { throw new AppError(401, 'TOKEN_INVALID', 'Refresh token hết hạn hoặc không hợp lệ'); }
    const user = await this.users.findOne({ where: { id: p.sub } });
    if (p.typ !== 'refresh' || !user || !user.isActive || user.tokenVersion !== p.ver)
      throw new AppError(401, 'TOKEN_INVALID', 'Refresh token không còn hiệu lực');
    return this.issue(user, res);
  }

  @Post('logout') @HttpCode(200) @ApiBearerAuth()
  async logout(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.users.increment({ id: u.id }, 'tokenVersion', 1); // revokes all tokens of this user
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }

  /** Change own password: revokes all other sessions and returns fresh tokens for this one. */
  @Post('change-password') @HttpCode(200) @ApiBearerAuth() @ApiOkResponse({ type: TokenResponse })
  async changePassword(@CurrentUser() u: AuthUser, @Body() dto: ChangePasswordDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.users.findOneOrFail({ where: { id: u.id } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) throw new AppError(400, 'WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
    if (dto.currentPassword === dto.newPassword) throw new AppError(400, 'SAME_PASSWORD', 'Mật khẩu mới phải khác mật khẩu cũ');
    user.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    user.tokenVersion += 1;
    await this.users.save(user);
    return this.issue(user, res);
  }

  @Get('me') @ApiBearerAuth() @ApiOkResponse({ type: UserView })
  me(@CurrentUser() u: AuthUser) { return u; }
}
