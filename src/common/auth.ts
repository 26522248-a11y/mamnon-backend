import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClassTeacher, Guardian, Role, User } from '../database/entities';
import { AppError, Forbidden } from './errors';

export interface AuthUser {
  id: string; username: string; name: string; role: Role;
  classIds: string[]; // teacher: classes taught
  childIds: string[]; // parent: own children
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

@Injectable()
export class UserContextService {
  constructor(
    @InjectRepository(ClassTeacher) private ct: Repository<ClassTeacher>,
    @InjectRepository(Guardian) private guardians: Repository<Guardian>,
  ) {}
  async build(u: User): Promise<AuthUser> {
    const classIds = u.role === 'teacher' ? (await this.ct.find({ where: { userId: u.id } })).map((x) => x.classId) : [];
    const childIds = u.role === 'parent' ? [...new Set((await this.guardians.find({ where: { userId: u.id } })).map((g) => g.childId))] : [];
    return { id: u.id, username: u.username, name: u.name, role: u.role, classIds, childIds };
  }
}

/** Global guard: validates Bearer access token (unless @Public) and enforces @Roles. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector, private jwt: JwtService, private ctx: UserContextService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest();
    const h: string | undefined = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Chưa đăng nhập');
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(h.slice(7), { secret: process.env.JWT_ACCESS_SECRET });
    } catch {
      throw new AppError(401, 'TOKEN_INVALID', 'Phiên đăng nhập hết hạn hoặc không hợp lệ');
    }
    if (payload.typ !== 'access') throw new AppError(401, 'TOKEN_INVALID', 'Token không hợp lệ');
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.tokenVersion !== payload.ver) throw new AppError(401, 'TOKEN_INVALID', 'Phiên đăng nhập không còn hiệu lực');
    req.user = await this.ctx.build(user);
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (roles && !roles.includes(req.user.role)) throw Forbidden('Vai trò của bạn không được phép thực hiện thao tác này');
    return true;
  }
}
