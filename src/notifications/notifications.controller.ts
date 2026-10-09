import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as crypto from 'crypto';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Brackets, DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth';
import { storage } from '../common/storage';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { Announcement, AnnouncementAttachment, Audience, Child, ClassTeacher, Notification, User } from '../database/entities';
import { AnnouncementsService, attView, MAX_ATTACHMENTS, vnIso } from './announcements.service';
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
  @ApiPropertyOptional({ example: '2026-10-10T07:30:00+07:00', description: 'Hẹn giờ gửi (ISO có múi giờ, vd +07:00). Bỏ trống = gửi ngay. Quá khứ → 400 SCHEDULE_IN_PAST' })
  @IsOptional() @IsISO8601({ strict: true }) scheduledAt?: string;
  @ApiPropertyOptional({ type: [String], description: `id ảnh đã tải lên qua POST /announcements/attachments (tối đa ${MAX_ATTACHMENTS})` })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_ATTACHMENTS) @IsUUID('all', { each: true }) attachmentIds?: string[];
}
export class PatchAnnouncementDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(5000) body?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() important?: boolean;
  @ApiPropertyOptional({ example: '2026-10-10T16:30:00+07:00' }) @IsOptional() @IsISO8601({ strict: true }) scheduledAt?: string;
  @ApiPropertyOptional({ type: [String], description: 'Danh sách ảnh mới (thay toàn bộ; ảnh bỏ ra bị xoá)' }) @IsOptional() @IsArray() @ArrayMaxSize(MAX_ATTACHMENTS) @IsUUID('all', { each: true }) attachmentIds?: string[];
}
export class PageQuery {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class AnnouncementQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() classId?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Gồm cả tin đã thu hồi (admin: tất cả; giáo viên: tin của mình)' }) @IsOptional() @IsIn(['true', 'false']) includeRecalled?: string;
  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Chỉ tin do tôi tạo' }) @IsOptional() @IsIn(['true', 'false']) mine?: string;
  @ApiPropertyOptional({ enum: ['scheduled', 'sent'], description: 'scheduled: tin hẹn giờ (chỉ người tạo / BGH thấy); mặc định: tin đã gửi' }) @IsOptional() @IsIn(['scheduled', 'sent']) status?: 'scheduled' | 'sent';
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
    status: a.status, scheduledAt: vnIso(a.scheduledAt), sentAt: vnIso(a.sentAt),
    canEdit: !!u && a.status === 'scheduled' && (u.role === 'admin' || a.createdBy === u.id),
    attachments: (a.attachments ?? []).slice().sort((x, y) => x.sortOrder - y.sortOrder).map(attView),
    ...(staffView ? { recipientUserIds: a.recipientUserIds ?? null, recipientCount: a.recipientCount } : {}),
  };
};
const notifView = (n: Notification) => ({
  id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, announcementId: n.announcementId, important: n.important,
  read: !!n.readAt, readAt: n.readAt, createdAt: n.createdAt,
});
/** pickup requests have their own feed (GET /pickup-requests/feed) and push; they are not part of the general inbox */
const VISIBLE = { hiddenAt: IsNull(), type: Not('pickup_request' as const) };

@ApiTags('notifications') @ApiBearerAuth()
@Controller()
export class NotificationsController {
  constructor(
    @InjectRepository(Announcement) private anns: Repository<Announcement>,
    @InjectRepository(Notification) private notifs: Repository<Notification>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(ClassTeacher) private ct: Repository<ClassTeacher>,
    private access: AccessService, private notify: NotificationsService, private ds: DataSource, private annSvc: AnnouncementsService,
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
    const scheduledAt = dto.scheduledAt ? this.futureTime(dto.scheduledAt) : null;
    let pushIds: string[] = [];
    const a = await this.ds.transaction(async (m) => {
      const a = await m.save(Announcement, m.create(Announcement, {
        title: dto.title, body: dto.body, scope: dto.scope!, classId: dto.classId ?? null, audience: dto.audience ?? 'all',
        important: !!dto.important, recipientUserIds: dto.audience === 'specific' ? dto.recipientUserIds! : null, createdBy: u.id,
        status: scheduledAt ? 'scheduled' : 'sent', scheduledAt,
      }));
      await this.linkAttachments(m, u, a.id, dto.attachmentIds ?? []);
      if (!scheduledAt) pushIds = await this.annSvc.deliver(m, a);
      return a;
    });
    if (pushIds.length) this.annSvc.push(a, pushIds);
    return annView((await this.loadAnn(a.id))!, u);
  }

  private loadAnn(id: string) {
    return this.anns.findOne({ where: { id }, relations: { classRoom: true, author: true, attachments: true } });
  }

  /** scheduledAt must be in the future (≥ now + 1 min) and ≤ 90 days ahead. */
  private futureTime(iso: string): Date {
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) throw BadRequest('scheduledAt cần có múi giờ, vd 2026-10-10T07:30:00+07:00', 'VALIDATION_ERROR');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw BadRequest('scheduledAt không hợp lệ', 'VALIDATION_ERROR');
    if (d.getTime() < Date.now() + 60_000) throw BadRequest('Thời gian hẹn gửi phải ở tương lai', 'SCHEDULE_IN_PAST');
    if (d.getTime() > Date.now() + 90 * 86400_000) throw BadRequest('Chỉ hẹn gửi trong vòng 90 ngày', 'SCHEDULE_TOO_FAR');
    return d;
  }

  /** Attach my uploaded (not yet linked) images, or the ones already on this announcement; order = ids order; others unlinked + deleted. */
  private async linkAttachments(m: any, u: AuthUser, annId: string, ids: string[]) {
    ids = [...new Set(ids)];
    if (ids.length > MAX_ATTACHMENTS) throw BadRequest(`Tối đa ${MAX_ATTACHMENTS} ảnh`, 'TOO_MANY_ATTACHMENTS');
    const rows: AnnouncementAttachment[] = ids.length ? await m.find(AnnouncementAttachment, { where: { id: In(ids) } }) : [];
    const bad = ids.filter((id) => { const r = rows.find((x) => x.id === id); return !r || (r.announcementId ? r.announcementId !== annId : r.uploadedBy !== u.id); });
    if (bad.length) throw new AppError(400, 'INVALID_ATTACHMENTS', 'Ảnh không hợp lệ hoặc không phải của bạn', { invalid: bad });
    const old: AnnouncementAttachment[] = await m.find(AnnouncementAttachment, { where: { announcementId: annId } });
    const dropped = old.filter((x) => !ids.includes(x.id));
    for (const [i, id] of ids.entries()) await m.update(AnnouncementAttachment, id, { announcementId: annId, sortOrder: i });
    if (dropped.length) { await m.delete(AnnouncementAttachment, dropped.map((x) => x.id)); for (const x of dropped) await this.annSvc.removeAttachmentFiles(x); }
  }

  @Post('announcements/attachments') @Roles('admin', 'teacher') @HttpCode(201)
  @ApiConsumes('multipart/form-data') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } }))
  @ApiOperation({ summary: 'Tải 1 ảnh (JPG/PNG/HEIC→JPEG, kiểm tra magic bytes, xoá EXIF, ≤ 2560px, ảnh thu nhỏ 360px). Gắn vào tin bằng attachmentIds.' })
  async upload(@CurrentUser() u: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    return attView(await this.annSvc.saveAttachment(file, u.id));
  }

  @Delete('announcements/attachments/:id') @Roles('admin', 'teacher') @HttpCode(204)
  async removeUpload(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const x = await this.ds.getRepository(AnnouncementAttachment).findOne({ where: { id }, relations: { announcement: true } });
    if (!x) throw NotFound('Không tìm thấy ảnh');
    if (x.announcement) {
      if (x.announcement.status !== 'scheduled') throw new AppError(409, 'NOT_EDITABLE', 'Tin đã gửi – không sửa ảnh được');
      if (u.role !== 'admin' && x.announcement.createdBy !== u.id) throw Forbidden('Không phải tin của bạn');
    } else if (x.uploadedBy !== u.id && u.role !== 'admin') throw Forbidden('Không phải ảnh của bạn');
    await this.ds.getRepository(AnnouncementAttachment).delete(id);
    await this.annSvc.removeAttachmentFiles(x);
  }

  @Get('announcements/attachments/:id')
  async attachment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { return this.sendAttachment(u, id, false, res); }
  @Get('announcements/attachments/:id/thumb')
  async attachmentThumb(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { return this.sendAttachment(u, id, true, res); }

  private async sendAttachment(u: AuthUser, id: string, thumb: boolean, res: Response) {
    const x = await this.ds.getRepository(AnnouncementAttachment).findOne({ where: { id }, relations: { announcement: true } });
    if (!x || !(await this.canSeeAttachment(u, x))) throw NotFound('Không tìm thấy ảnh');
    const buf = await storage().get(thumb ? x.thumbKey : x.fileKey);
    if (!buf) throw NotFound('Không tìm thấy file ảnh');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);
  }

  private async canSeeAttachment(u: AuthUser, x: AnnouncementAttachment) {
    const a = x.announcement;
    if (!a) return x.uploadedBy === u.id || u.role === 'admin';
    if (u.role === 'admin' || a.createdBy === u.id) return true;
    if (a.status !== 'sent' || a.recalledAt) return false;
    if (await this.notifs.exist({ where: { announcementId: a.id, userId: u.id } })) return true;
    return this.isStaff(u) && a.audience !== 'parents' && a.audience !== 'specific' && (a.scope === 'school' || (u.role === 'teacher' && !!a.classId && u.classIds.includes(a.classId)));
  }

  private async editable(u: AuthUser, id: string) {
    const a = await this.anns.findOne({ where: { id } });
    if (!a) throw NotFound('Không tìm thấy thông báo');
    if (u.role !== 'admin' && a.createdBy !== u.id) throw Forbidden('Chỉ người tạo hoặc Ban giám hiệu được sửa');
    if (a.status !== 'scheduled') throw new AppError(409, 'NOT_SCHEDULED', a.status === 'sent' ? 'Tin đã gửi – không sửa / huỷ hẹn được' : 'Tin đã huỷ');
    return a;
  }

  @Patch('announcements/:id') @Roles('admin', 'teacher')
  @ApiOperation({ summary: 'Sửa tin hẹn giờ (chỉ khi status=scheduled; đã gửi → 409 NOT_SCHEDULED)' })
  async patch(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchAnnouncementDto) {
    await this.editable(u, id);
    const scheduledAt = dto.scheduledAt ? this.futureTime(dto.scheduledAt) : undefined;
    await this.ds.transaction(async (m) => {
      const [row] = await m.query(`SELECT status FROM announcements WHERE id = $1 FOR UPDATE`, [id]);
      if (row?.status !== 'scheduled') throw new AppError(409, 'NOT_SCHEDULED', 'Tin vừa được gửi – không sửa được');
      const patch: Partial<Announcement> = {};
      if (dto.title !== undefined) patch.title = dto.title;
      if (dto.body !== undefined) patch.body = dto.body;
      if (dto.important !== undefined) patch.important = dto.important;
      if (scheduledAt) patch.scheduledAt = scheduledAt;
      if (Object.keys(patch).length) await m.update(Announcement, id, patch);
      if (dto.attachmentIds) await this.linkAttachments(m, u, id, dto.attachmentIds);
    });
    return annView((await this.loadAnn(id))!, u);
  }

  @Post('announcements/:id/cancel') @Roles('admin', 'teacher') @HttpCode(200)
  @ApiOperation({ summary: 'Huỷ hẹn giờ (chỉ khi status=scheduled) → status=revoked; không ai nhận được' })
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.editable(u, id);
    const r = await this.ds.query(`UPDATE announcements SET status = 'revoked', recalled_at = now(), recalled_by = $2 WHERE id = $1 AND status = 'scheduled' RETURNING id`, [id, u.id]);
    const rows = Array.isArray(r?.[0]) ? r[0] : r;
    if (!rows?.length) throw new AppError(409, 'NOT_SCHEDULED', 'Tin vừa được gửi – không huỷ được');
    return annView((await this.loadAnn(id))!, u);
  }

  /** External cron (cron-job.org…) wakes the API and dispatches due announcements. Header X-Cron-Secret = CRON_SECRET. */
  @Public() @Post('internal/cron/announcements') @HttpCode(200)
  @ApiHeader({ name: 'X-Cron-Secret', required: true })
  async cron(@Headers('x-cron-secret') secret?: string) {
    const want = process.env.CRON_SECRET || '';
    const ok = !!want && !!secret && secret.length === want.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(want));
    if (!ok) throw new AppError(401, 'UNAUTHORIZED', 'Sai hoặc thiếu X-Cron-Secret');
    const r = await this.annSvc.runDue();
    return { ok: true, sent: r.sent.length, ids: r.sent };
  }

  @Get('announcements')
  async list(@CurrentUser() u: AuthUser, @Query() q: AnnouncementQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const qb = this.anns.createQueryBuilder('a').leftJoinAndSelect('a.classRoom', 'cl').leftJoinAndSelect('a.author', 'au').leftJoinAndSelect('a.attachments', 'att');
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
    // B9: scheduled ones only for their author / admin; everyone else (parents!) sees sent only
    if (q.status === 'scheduled') {
      qb.andWhere("a.status = 'scheduled'");
      if (u.role !== 'admin') qb.andWhere('a.created_by = :me', { me: u.id });
    } else qb.andWhere("a.status <> 'scheduled'");
    if (q.classId) qb.andWhere('a.class_id = :cid', { cid: q.classId });
    if (q.status === 'scheduled') qb.orderBy('a.scheduledAt', 'ASC'); else qb.orderBy('a.sentAt', 'DESC', 'NULLS LAST').addOrderBy('a.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
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
      await m.update(Announcement, id, { recalledAt: () => 'now()', recalledBy: u.id, status: 'revoked' } as any);
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
    const r = await this.notifs.createQueryBuilder().update().set({ readAt: () => 'now()' }).where("user_id = :u AND read_at IS NULL AND hidden_at IS NULL AND type <> 'pickup_request'", { u: u.id }).execute();
    return { updated: r.affected ?? 0 };
  }
}
