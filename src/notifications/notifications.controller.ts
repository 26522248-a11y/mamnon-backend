import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Brackets, DataSource, In, IsNull, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { Announcement, Audience, Child, ClassTeacher, Notification, User } from '../database/entities';
import { NotificationsService } from './notifications.service';

export class CreateAnnouncementDto {
  @ApiProperty({ example: 'Nghỉ lễ 20/11' }) @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ example: 'Trường nghỉ ngày 20/11, các bé đi học lại ngày 21/11.' }) @IsString() @MinLength(1) @MaxLength(5000) body!: string;
  @ApiPropertyOptional({ enum: ['school', 'class'], description: 'Bắt buộc trừ khi audience=specific (khi đó suy ra từ classId)' }) @IsOptional() @IsIn(['school', 'class']) scope?: 'school' | 'class';
  @ApiPropertyOptional({ description: 'Bắt buộc khi scope=class' }) @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ enum: ['all', 'parents', 'staff', 'specific'], default: 'all', description: "'specific' = chỉ các phụ huynh trong recipientUserIds" })
  @IsOptional() @IsIn(['all', 'parents', 'staff', 'specific']) audience?: Audience;
  @ApiPropertyOptional({ type: [String], description: 'audience=specific: id tài khoản phụ huynh. Giáo viên chỉ chọn được phụ huynh của trẻ lớp mình; admin chọn bất kỳ.' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) recipientUserIds?: string[];
  @ApiPropertyOptional({ default: false, description: 'Thông báo quan trọng (hiện cả trong hộp thư: notification.important)' }) @IsOptional() @IsBoolean() important?: boolean;
}
export class PageQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class AnnouncementQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Gồm cả tin đã thu hồi (admin: tất cả; giáo viên: tin của mình)' }) @IsOptional() @IsIn(['true', 'false']) includeRecalled?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Chỉ tin do tôi tạo' }) @IsOptional() @IsIn(['true', 'false']) mine?: string;
}
export class NotificationQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['true', 'false'] }) @IsOptional() @IsIn(['true', 'false']) unreadOnly?: string;
}

const annView = (a: Announcement, u?: AuthUser) => {
  const staffView = !u || u.role === 'admin' || a.createdBy === u.id; // parents never see who else got a 'specific' message
  return {
    id: a.id, title: a.title, body: a.body, scope: a.scope, classId: a.classId, className: a.classRoom?.name ?? null, audience: a.audience,
    important: a.important, createdBy: a.createdBy, authorName: a.author?.name ?? null, createdAt: a.createdAt,
    mine: !!u && a.createdBy === u.id, canRecall: !!u && !a.recalledAt && (u.role === 'admin' || a.createdBy === u.id),
    recalled: !!a.recalledAt, recalledAt: a.recalledAt, recalledBy: a.recalledBy,
    ...(staffView ? { recipientUserIds: a.recipientUserIds ?? null, recipientCount: a.recipientCount } : {}),
  };
};
const notifView = (n: Notification) => ({
  id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, announcementId: n.announcementId, important: n.important,
  read: !!n.readAt, readAt: n.readAt, createdAt: n.createdAt,
});
const VISIBLE = { hiddenAt: IsNull() };

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
    if (a.audience === 'specific') return [...new Set(a.recipientUserIds ?? [])].filter((id) => id !== a.createdBy);
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

  /** Parents a teacher may address directly: guardians (with an account) of active children in the teacher's classes. */
  private async parentsOfClasses(classIds: string[]): Promise<Set<string>> {
    if (!classIds.length) return new Set();
    const rows = await this.ds.query(`SELECT DISTINCT g.user_id FROM guardians g JOIN children c ON c.id = g.child_id JOIN users u ON u.id = g.user_id
      WHERE c.class_id = ANY($1) AND c.status = 'active' AND u.role = 'parent' AND u.is_active`, [classIds]);
    return new Set(rows.map((r: any) => r.user_id));
  }

  @Post('announcements') @Roles('admin', 'teacher')
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateAnnouncementDto) {
    if (dto.recipientUserIds?.length && !dto.audience) dto.audience = 'specific';
    if (dto.audience === 'specific') {
      if (!dto.recipientUserIds?.length) throw BadRequest('audience=specific cần recipientUserIds', 'RECIPIENTS_REQUIRED');
      dto.recipientUserIds = [...new Set(dto.recipientUserIds)];
      if (dto.classId) { await this.access.getClassOr404(dto.classId); this.access.assertOperateClass(u, dto.classId); }
      dto.scope = dto.classId ? 'class' : 'school';
      const parents = await this.users.find({ where: { id: In(dto.recipientUserIds), role: 'parent', isActive: true }, select: { id: true } });
      const bad = dto.recipientUserIds.filter((id) => !parents.some((p) => p.id === id));
      if (bad.length) throw new AppError(400, 'INVALID_RECIPIENTS', 'recipientUserIds chỉ gồm tài khoản phụ huynh đang hoạt động', { invalid: bad });
      if (u.role !== 'admin') {
        const allowed = await this.parentsOfClasses(dto.classId ? [dto.classId] : u.classIds);
        const notMine = dto.recipientUserIds.filter((id) => !allowed.has(id));
        if (notMine.length) throw new AppError(403, 'FORBIDDEN', 'Giáo viên chỉ gửi được cho phụ huynh của trẻ lớp mình', { invalid: notMine });
      }
    } else {
      if (dto.recipientUserIds?.length) throw BadRequest('recipientUserIds chỉ dùng với audience=specific', 'VALIDATION_ERROR');
      if (!dto.scope) throw BadRequest('Thiếu scope (school | class)', 'VALIDATION_ERROR');
      if (dto.scope === 'class') {
        if (!dto.classId) throw Forbidden('Thông báo lớp cần classId');
        await this.access.getClassOr404(dto.classId);
        this.access.assertOperateClass(u, dto.classId); // teacher: own class only
      } else {
        if (u.role !== 'admin') throw Forbidden('Chỉ Ban giám hiệu được gửi thông báo toàn trường');
        dto.classId = undefined;
      }
    }
    const a = await this.ds.transaction(async (m) => {
      const a = await m.save(Announcement, m.create(Announcement, {
        title: dto.title, body: dto.body, scope: dto.scope!, classId: dto.classId ?? null, audience: dto.audience ?? 'all',
        important: !!dto.important, recipientUserIds: dto.audience === 'specific' ? dto.recipientUserIds! : null, createdBy: u.id,
      }));
      const n = await this.notify.toUsers(await this.recipients(a), {
        type: 'announcement', title: a.title, body: a.body.length > 300 ? a.body.slice(0, 297) + '...' : a.body, important: a.important,
        data: { announcementId: a.id, scope: a.scope, classId: a.classId, important: a.important, audience: a.audience }, announcementId: a.id,
      }, m);
      await m.update(Announcement, a.id, { recipientCount: n });
      return a;
    });
    const full = await this.anns.findOne({ where: { id: a.id }, relations: { classRoom: true, author: true } });
    return annView(full!, u);
  }

  @Get('announcements')
  async list(@CurrentUser() u: AuthUser, @Query() q: AnnouncementQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const qb = this.anns.createQueryBuilder('a').leftJoinAndSelect('a.classRoom', 'cl').leftJoinAndSelect('a.author', 'au');
    qb.where('1=1');
    if (u.role !== 'admin') {
      const aud = this.isStaff(u) ? ['all', 'staff'] : ['all', 'parents'];
      const cids = (await this.visibleClassIds(u)) ?? [];
      qb.andWhere(new Brackets((w) => {
        // addressed to me by scope/audience
        w.where(new Brackets((x) => x.where('a.audience IN (:...aud)', { aud }).andWhere(new Brackets((y) => {
          y.where("a.scope = 'school'").orWhere("a.scope = 'class' AND a.class_id = ANY(:cids)", { cids });
        }))));
        // picked by name (audience=specific)
        w.orWhere("a.audience = 'specific' AND :me = ANY(a.recipient_user_ids)", { me: u.id });
        // my own announcements (teacher: still scoped to own classes)
        w.orWhere(new Brackets((x) => x.where('a.created_by = :me', { me: u.id }).andWhere(new Brackets((y) => {
          y.where("a.scope = 'school'").orWhere('a.class_id = ANY(:cids)', { cids }).orWhere("a.audience = 'specific' AND a.class_id IS NULL");
        }))));
      }));
    }
    const withRecalled = q.includeRecalled === 'true' && this.isStaff(u);
    if (!withRecalled) qb.andWhere('a.recalled_at IS NULL');
    else if (u.role !== 'admin') qb.andWhere('(a.recalled_at IS NULL OR a.created_by = :me)', { me: u.id });
    if (q.mine === 'true') qb.andWhere('a.created_by = :me', { me: u.id });
    if (q.classId) qb.andWhere('a.class_id = :cid', { cid: q.classId });
    qb.orderBy('a.createdAt', 'DESC').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { items: rows.map((a) => annView(a, u)), page, limit, total };
  }

  /** Parent accounts selectable for audience=specific (teacher: parents of active children in own classes; admin: all). */
  @Get('announcements/recipients') @Roles('admin', 'teacher')
  async recipientOptions(@CurrentUser() u: AuthUser, @Query('classId') classId?: string) {
    if (classId) { await this.access.getClassOr404(classId); if (u.role !== 'admin') this.access.assertOperateClass(u, classId); }
    const cids = classId ? [classId] : u.role === 'admin' ? null : u.classIds;
    const rows: any[] = await this.ds.query(`
      SELECT u.id AS "userId", u.name, u.phone, c.id AS "childId", c.full_name AS "childName", cl.id AS "classId", cl.name AS "className", g.relation
      FROM guardians g JOIN users u ON u.id = g.user_id JOIN children c ON c.id = g.child_id LEFT JOIN classes cl ON cl.id = c.class_id
      WHERE u.role = 'parent' AND u.is_active AND c.status = 'active' ${cids ? 'AND c.class_id = ANY($1)' : ''}
      ORDER BY cl.name, c.full_name, u.name`, cids ? [cids] : []);
    const byUser = new Map<string, any>();
    for (const r of rows) {
      const e = byUser.get(r.userId) ?? { userId: r.userId, name: r.name, phone: r.phone, children: [] as any[] };
      e.children.push({ id: r.childId, fullName: r.childName, classId: r.classId, className: r.className, relation: r.relation });
      byUser.set(r.userId, e);
    }
    return { items: [...byUser.values()] };
  }

  /** Recall = soft delete: announcement kept (recalledAt/recalledBy), derived notifications hidden from every inbox and unread count. */
  @Delete('announcements/:id') @Roles('admin', 'teacher') @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.anns.findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy thông báo');
    if (u.role !== 'admin' && a.createdBy !== u.id) throw Forbidden('Chỉ người tạo hoặc Ban giám hiệu được thu hồi');
    if (a.recalledAt) throw new AppError(409, 'ALREADY_RECALLED', 'Thông báo đã được thu hồi');
    await this.ds.transaction(async (m) => {
      await m.update(Announcement, id, { recalledAt: () => 'now()', recalledBy: u.id } as any);
      await m.createQueryBuilder().update(Notification).set({ hiddenAt: () => 'now()' }).where('announcement_id = :id AND hidden_at IS NULL', { id }).execute();
    });
  }

  // ───── personal inbox ─────
  @Get('notifications')
  async inbox(@CurrentUser() u: AuthUser, @Query() q: NotificationQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const where: any = { userId: u.id, ...VISIBLE, ...(q.unreadOnly === 'true' ? { readAt: IsNull() } : {}) };
    const [rows, total] = await this.notifs.findAndCount({ where, order: { createdAt: 'DESC' }, skip: (page - 1) * limit, take: limit });
    const unreadCount = await this.notifs.count({ where: { userId: u.id, readAt: IsNull(), ...VISIBLE } });
    const importantUnreadCount = await this.notifs.count({ where: { userId: u.id, readAt: IsNull(), important: true, ...VISIBLE } });
    return { items: rows.map(notifView), page, limit, total, unreadCount, importantUnreadCount };
  }

  @Get('notifications/unread-count')
  async unread(@CurrentUser() u: AuthUser) {
    return {
      unreadCount: await this.notifs.count({ where: { userId: u.id, readAt: IsNull(), ...VISIBLE } }),
      importantUnreadCount: await this.notifs.count({ where: { userId: u.id, readAt: IsNull(), important: true, ...VISIBLE } }),
    };
  }

  @Post('notifications/:id/read') @HttpCode(200)
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const n = await this.notifs.findOne({ where: { id, userId: u.id, ...VISIBLE } }); // other users' / recalled items look like 404
    if (!n) throw NotFound('Không tìm thấy thông báo');
    if (!n.readAt) { n.readAt = new Date(); await this.notifs.save(n); }
    return notifView(n);
  }

  @Post('notifications/read-all') @HttpCode(200)
  async readAll(@CurrentUser() u: AuthUser) {
    const r = await this.notifs.createQueryBuilder().update().set({ readAt: () => 'now()' }).where('user_id = :u AND read_at IS NULL AND hidden_at IS NULL', { u: u.id }).execute();
    return { updated: r.affected ?? 0 };
  }
}
