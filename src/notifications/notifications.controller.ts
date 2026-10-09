import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Brackets, DataSource, In, IsNull, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { Forbidden, NotFound } from '../common/errors';
import { Announcement, Audience, Child, ClassTeacher, Notification, User } from '../database/entities';
import { NotificationsService } from './notifications.service';

export class CreateAnnouncementDto {
  @ApiProperty({ example: 'Nghỉ lễ 20/11' }) @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ example: 'Trường nghỉ ngày 20/11, các bé đi học lại ngày 21/11.' }) @IsString() @MinLength(1) @MaxLength(5000) body!: string;
  @ApiProperty({ enum: ['school', 'class'] }) @IsIn(['school', 'class']) scope!: 'school' | 'class';
  @ApiPropertyOptional({ description: 'Bắt buộc khi scope=class' }) @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ enum: ['all', 'parents', 'staff'], default: 'all' }) @IsOptional() @IsIn(['all', 'parents', 'staff']) audience?: Audience;
}
export class PageQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class AnnouncementQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
}
export class NotificationQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'] }) @IsOptional() @IsIn(['true', 'false']) unreadOnly?: string;
}

const annView = (a: Announcement) => ({
  id: a.id, title: a.title, body: a.body, scope: a.scope, classId: a.classId, className: a.classRoom?.name ?? null, audience: a.audience,
  createdBy: a.createdBy, authorName: a.author?.name ?? null, createdAt: a.createdAt,
});
const notifView = (n: Notification) => ({
  id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, announcementId: n.announcementId, read: !!n.readAt, readAt: n.readAt, createdAt: n.createdAt,
});

@ApiTags('notifications') @ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(
    @InjectRepository(Announcement) private anns: Repository<Announcement>,
    @InjectRepository(Notification) private notifs: Repository<Notification>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(ClassTeacher) private ct: Repository<ClassTeacher>,
    private access: AccessService, private notify: NotificationsService, private ds: DataSource,
  ) {}

  private isStaff(u: AuthUser) { return u.role !== 'parent'; }
  private async parentClassIds(u: AuthUser) {
    if (u.role !== 'parent' || !u.childIds.length) return [];
    return [...new Set((await this.children.find({ where: { id: In(u.childIds) } })).map((c) => c.classId).filter(Boolean) as string[])];
  }
  /** Classes whose class-scoped announcements the user may see. admin: all (null = no filter). */
  private async visibleClassIds(u: AuthUser): Promise<string[] | null> {
    if (u.role === 'admin') return null;
    if (u.role === 'teacher') return u.classIds;
    if (u.role === 'parent') return this.parentClassIds(u);
    return []; // accountant: school-wide only
  }

  /** Recipients by scope & audience (author excluded). */
  private async recipients(a: Announcement): Promise<string[]> {
    const ids: string[] = [];
    const wantParents = a.audience !== 'staff', wantStaff = a.audience !== 'parents';
    if (a.scope === 'school') {
      const roles = [...(wantParents ? ['parent'] : []), ...(wantStaff ? ['admin', 'teacher', 'accountant'] : [])];
      ids.push(...(await this.users.find({ where: { isActive: true, role: In(roles) }, select: { id: true } })).map((x) => x.id));
    } else {
      if (wantParents) {
        const kids = await this.children.find({ where: { classId: a.classId!, status: 'active' }, select: { id: true } });
        ids.push(...(await this.notify.parentIdsOfChildren(kids.map((k) => k.id))));
      }
      if (wantStaff) {
        ids.push(...(await this.ct.find({ where: { classId: a.classId! } })).map((t) => t.userId));
        ids.push(...(await this.users.find({ where: { isActive: true, role: 'admin' }, select: { id: true } })).map((x) => x.id));
      }
    }
    return [...new Set(ids)].filter((id) => id !== a.createdBy);
  }

  @Post('announcements') @Roles('admin', 'teacher')
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateAnnouncementDto) {
    if (dto.scope === 'class') {
      if (!dto.classId) throw Forbidden('Thông báo lớp cần classId');
      await this.access.getClassOr404(dto.classId);
      this.access.assertOperateClass(u, dto.classId); // teacher: own class only
    } else {
      if (u.role !== 'admin') throw Forbidden('Chỉ Ban giám hiệu được gửi thông báo toàn trường');
      dto.classId = undefined;
    }
    const a = await this.ds.transaction(async (m) => {
      const a = await m.save(Announcement, m.create(Announcement, { ...dto, classId: dto.classId ?? null, audience: dto.audience ?? 'all', createdBy: u.id }));
      const n = await this.notify.toUsers(await this.recipients(a), {
        type: 'announcement', title: a.title, body: a.body.length > 300 ? a.body.slice(0, 297) + '...' : a.body,
        data: { announcementId: a.id, scope: a.scope, classId: a.classId }, announcementId: a.id,
      }, m);
      return Object.assign(a, { recipientCount: n });
    });
    const full = await this.anns.findOne({ where: { id: a.id }, relations: { classRoom: true, author: true } });
    return { ...annView(full!), recipientCount: (a as any).recipientCount };
  }

  @Get('announcements')
  async list(@CurrentUser() u: AuthUser, @Query() q: AnnouncementQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const qb = this.anns.createQueryBuilder('a').leftJoinAndSelect('a.classRoom', 'cl').leftJoinAndSelect('a.author', 'au');
    if (u.role !== 'admin') {
      const aud = this.isStaff(u) ? ['all', 'staff'] : ['all', 'parents'];
      const cids = (await this.visibleClassIds(u)) ?? [];
      qb.where('a.audience IN (:...aud)', { aud }).andWhere(new Brackets((w) => {
        w.where("a.scope = 'school'").orWhere("a.scope = 'class' AND a.class_id = ANY(:cids)", { cids });
      }));
    }
    if (q.classId) qb.andWhere('a.class_id = :cid', { cid: q.classId });
    qb.orderBy('a.createdAt', 'DESC').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map(annView), page, limit, total };
  }

  @Delete('announcements/:id') @Roles('admin', 'teacher') @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.anns.findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy thông báo');
    if (u.role !== 'admin' && a.createdBy !== u.id) throw Forbidden('Chỉ người tạo hoặc Ban giám hiệu được xoá');
    await this.anns.delete(id); // inbox items cascade
  }

  // ───── personal inbox ─────
  @Get('notifications')
  async inbox(@CurrentUser() u: AuthUser, @Query() q: NotificationQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const where: any = { userId: u.id, ...(q.unreadOnly === 'true' ? { readAt: IsNull() } : {}) };
    const [rows, total] = await this.notifs.findAndCount({ where, order: { createdAt: 'DESC' }, skip: (page - 1) * limit, take: limit });
    const unreadCount = await this.notifs.count({ where: { userId: u.id, readAt: IsNull() } });
    return { items: rows.map(notifView), page, limit, total, unreadCount };
  }

  @Get('notifications/unread-count')
  async unread(@CurrentUser() u: AuthUser) {
    return { unreadCount: await this.notifs.count({ where: { userId: u.id, readAt: IsNull() } }) };
  }

  @Post('notifications/:id/read') @HttpCode(200)
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const n = await this.notifs.findOne({ where: { id, userId: u.id } }); // other users' items look like 404
    if (!n) throw NotFound('Không tìm thấy thông báo');
    if (!n.readAt) { n.readAt = new Date(); await this.notifs.save(n); }
    return notifView(n);
  }

  @Post('notifications/read-all') @HttpCode(200)
  async readAll(@CurrentUser() u: AuthUser) {
    const r = await this.notifs.createQueryBuilder().update().set({ readAt: () => 'now()' }).where('user_id = :u AND read_at IS NULL', { u: u.id }).execute();
    return { updated: r.affected ?? 0 };
  }
}
