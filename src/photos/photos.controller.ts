import {
  ArgumentsHost, BadRequestException, Body, Catch, Controller, Delete, ExceptionFilter, Get, HttpCode, Param, ParseUUIDPipe, PayloadTooLargeException, Post,
  Put, Query, Req, Res, UploadedFiles, UseFilters, UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { memoryStorage } from 'multer';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { AbsencesService } from '../absences/absences.service';
import { AccessService } from '../common/access';
import { recordAudit } from '../common/audit';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AllExceptionsFilter, AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { Photo, PhotoLike, PhotoPost, PhotoTag, User } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';
import { PHOTO_MAX_BYTES, PHOTO_MAX_FILES, photoPath, processPhoto, removePhotoFiles, storePhoto } from './images';
import { assertConsent } from './photo-rules';

/** Multer limit errors on the upload route → 413 FILE_TOO_LARGE / 400 TOO_MANY_FILES; everything else → global format. */
@Catch()
class UploadLimitFilter implements ExceptionFilter {
  private fallback = new AllExceptionsFilter();
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof PayloadTooLargeException) return res.status(413).json({ code: 'FILE_TOO_LARGE', message: `Mỗi ảnh tối đa ${PHOTO_MAX_BYTES / 1024 / 1024}MB` });
    if (e instanceof BadRequestException && /Too many files|Unexpected field/i.test(String((e.getResponse() as any)?.message ?? e.message)))
      return res.status(400).json({ code: 'TOO_MANY_FILES', message: `Tối đa ${PHOTO_MAX_FILES} ảnh mỗi lần đăng` });
    return this.fallback.catch(e, host);
  }
}

export class CreatePostDto {
  @ApiPropertyOptional({ example: 'Vẽ tranh mùa thu 🍂' }) @IsOptional() @IsString() @MaxLength(300) caption?: string;
  @ApiPropertyOptional({ description: 'JSON: mảng (cùng thứ tự với files) các mảng childId, vd [["id1"],[]]' }) @IsOptional() @IsString() tags?: string;
}
export class PostsQuery {
  @ApiPropertyOptional() @IsOptional() @IsISO8601() before?: string;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
export class TagsDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(60) @IsUUID('all', { each: true }) childIds!: string[];
}
export class FileQuery {
  @ApiPropertyOptional({ enum: ['thumb', 'full'] }) @IsOptional() @IsIn(['thumb', 'full']) size?: 'thumb' | 'full';
  @ApiPropertyOptional({ enum: ['0', '1'] }) @IsOptional() @IsIn(['0', '1']) download?: '0' | '1';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Class activity album (round 3 §2). Consent enforced server-side; files only via the authenticated endpoint. */
@ApiTags('photos') @ApiBearerAuth()
@Controller()
export class PhotosController {
  constructor(private ds: DataSource, private access: AccessService, private notify: NotificationsService, private absences: AbsencesService) {}

  // ───── access ─────
  private async parentHasChildInClass(u: AuthUser, classId: string) {
    if (u.role !== 'parent' || !u.childIds.length) return false;
    const [{ n }] = await this.ds.query(`SELECT COUNT(*)::int n FROM children WHERE id = ANY($1) AND class_id = $2 AND status = 'active'`, [u.childIds, classId]);
    return n > 0;
  }
  private isStaff(u: AuthUser, classId: string) { return u.role === 'admin' || (u.role === 'teacher' && u.classIds.includes(classId)); }
  private async assertView(u: AuthUser, classId: string) {
    if (this.isStaff(u, classId) || (await this.parentHasChildInClass(u, classId))) return;
    throw Forbidden('Chỉ phụ huynh và giáo viên của lớp được xem album');
  }
  private assertManage(u: AuthUser, classId: string) {
    if (!this.isStaff(u, classId)) throw Forbidden('Chỉ giáo viên phụ trách lớp hoặc quản trị được thao tác');
  }
  /** Children must be active and in the class. */
  private async assertInClass(m: { query: EntityManager['query'] }, classId: string, childIds: string[]) {
    if (!childIds.length) return;
    const ok: { id: string }[] = await m.query(`SELECT id FROM children WHERE id = ANY($1) AND class_id = $2 AND status = 'active'`, [childIds, classId]);
    const bad = childIds.filter((id) => !ok.some((o) => o.id === id));
    if (bad.length) {
      const names: { childId: string; name: string }[] = await m.query(`SELECT id AS "childId", full_name AS name FROM children WHERE id = ANY($1)`, [bad]);
      throw new AppError(400, 'CHILD_NOT_IN_CLASS', 'Có bé không thuộc lớp này', { children: bad.map((id) => ({ childId: id, name: names.find((n) => n.childId === id)?.name ?? null })) });
    }
  }
  private async loadPhoto(id: string) {
    const p = await this.ds.getRepository(Photo).findOne({ where: { id, deletedAt: IsNull() }, relations: { post: true, tags: true } });
    if (!p || p.post.deletedAt) throw NotFound('Không tìm thấy ảnh');
    return p;
  }

  // ───── views ─────
  private async views(u: AuthUser, posts: PhotoPost[]) {
    if (!posts.length) return [];
    const ids = posts.map((p) => p.id);
    const photos = await this.ds.getRepository(Photo).find({ where: { postId: In(ids), deletedAt: IsNull() }, relations: { tags: true }, order: { position: 'ASC' } });
    const likes: { post_id: string; n: number; mine: boolean }[] = await this.ds.query(
      `SELECT post_id, COUNT(*)::int n, bool_or(user_id = $2) mine FROM photo_likes WHERE post_id = ANY($1) GROUP BY post_id`, [ids, u.id]);
    const childIds = [...new Set(photos.flatMap((p) => [...p.tags.map((t) => t.childId), ...p.hiddenForChildIds]))];
    const names = new Map<string, string>((childIds.length ? await this.ds.query(`SELECT id, full_name FROM children WHERE id = ANY($1)`, [childIds]) : [])
      .map((r: any) => [r.id, r.full_name]));
    const named = (ids: string[]) => ids.map((id) => ({ childId: id, name: names.get(id) ?? null }));
    const out = [];
    for (const post of posts) {
      const staff = this.isStaff(u, post.classId);
      const ps = photos.filter((p) => p.postId === post.id && (staff || !p.hidden)).map((p) => {
        const tagIds = p.tags.map((t) => t.childId);
        const visible = staff ? tagIds : tagIds.filter((id) => u.childIds.includes(id)); // parents never learn other kids' tags
        return { id: p.id, width: p.width, height: p.height, childIds: visible, children: named(visible), mine: tagIds.some((id) => u.childIds.includes(id)),
          hidden: p.hidden, hiddenReason: staff ? p.hiddenReason : null, hiddenForChildIds: staff ? p.hiddenForChildIds : [],
          hiddenFor: staff ? named(p.hiddenForChildIds) : [], hiddenAt: staff ? p.hiddenAt : null };
      });
      if (!staff && !ps.length) continue;
      const l = likes.find((x) => x.post_id === post.id);
      out.push({ id: post.id, classId: post.classId, caption: post.caption, createdAt: post.createdAt, author: post.author ? { id: post.author.id, name: post.author.name } : null,
        likeCount: l?.n ?? 0, likedByMe: !!l?.mine, photos: ps });
    }
    return out;
  }

  // ───── posts ─────
  @Post('classes/:classId/photo-posts') @Roles('teacher', 'admin')
  @UseFilters(UploadLimitFilter)
  @UseInterceptors(AnyFilesInterceptor({ storage: memoryStorage(), limits: { fileSize: PHOTO_MAX_BYTES, files: PHOTO_MAX_FILES } }))
  @ApiConsumes('multipart/form-data')
  async create(@CurrentUser() u: AuthUser, @Param('classId', ParseUUIDPipe) classId: string, @Body() dto: CreatePostDto,
    @UploadedFiles() all: Express.Multer.File[] = [], @Req() req: Request) {
    await this.access.getClassOr404(classId);
    this.assertManage(u, classId);
    const files = (all ?? []).filter((f) => f.fieldname === 'files' || f.fieldname === 'files[]');
    if (!files.length) throw BadRequest('Cần ít nhất 1 ảnh (files)', 'VALIDATION_ERROR');
    let tags: string[][] = files.map(() => []);
    if (dto.tags?.trim()) {
      let parsed: unknown;
      try { parsed = JSON.parse(dto.tags); } catch { throw BadRequest('tags phải là JSON', 'VALIDATION_ERROR'); }
      if (!Array.isArray(parsed) || parsed.length !== files.length || !parsed.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && UUID.test(x))))
        throw BadRequest('tags phải là mảng (cùng số phần tử với files) các mảng childId', 'VALIDATION_ERROR');
      tags = (parsed as string[][]).map((a) => [...new Set(a)]);
    }
    const tagged = [...new Set(tags.flat())];
    await this.assertInClass(this.ds, classId, tagged);
    await assertConsent(this.ds, tagged); // ALB-01/08: nothing is saved
    const processed: Awaited<ReturnType<typeof processPhoto>>[] = [];
    for (const f of files) processed.push(await processPhoto(f.buffer, f.originalname)); // ALB-05: all validated before anything is written
    const stored = processed.map((p) => storePhoto(classId, p));
    let postId: string;
    try {
      postId = await this.ds.transaction(async (m) => {
        await assertConsent(m, tagged); // re-check inside the transaction (consent may change meanwhile)
        const post = await m.save(PhotoPost, m.create(PhotoPost, { classId, caption: dto.caption?.trim() || null, authorId: u.id }));
        const saved: Photo[] = [];
        for (let i = 0; i < processed.length; i++) {
          const ph = await m.save(Photo, m.create(Photo, { postId: post.id, classId, position: i, fileKey: stored[i].fileKey, thumbKey: stored[i].thumbKey,
            width: processed[i].width, height: processed[i].height, hiddenForChildIds: [] }));
          if (tags[i].length) await m.save(PhotoTag, tags[i].map((childId) => m.create(PhotoTag, { photoId: ph.id, childId, createdBy: u.id })));
          saved.push(ph);
        }
        await recordAudit(m, u, { action: 'photo_post.create', entityType: 'photo_post', entityId: post.id, before: null,
          after: { classId, caption: post.caption, photos: saved.map((p, i) => ({ id: p.id, childIds: tags[i] })) }, ip: req.ip });
        return post.id;
      });
    } catch (e) { removePhotoFiles(stored.flatMap((s) => [s.fileKey, s.thumbKey])); throw e; }
    const parents: { user_id: string }[] = await this.ds.query(`SELECT DISTINCT g.user_id FROM guardians g JOIN children c ON c.id = g.child_id
      JOIN users us ON us.id = g.user_id WHERE c.class_id = $1 AND c.status = 'active' AND us.is_active AND us.role = 'parent'`, [classId]);
    const cls = await this.access.getClassOr404(classId);
    await this.notify.send(parents.map((p) => p.user_id), { type: 'photo_post', title: `Lớp ${cls.name} có ảnh hoạt động mới`,
      body: dto.caption?.trim() || `${files.length} ảnh`, data: { postId, classId }, refId: postId });
    return this.getPost(u, postId);
  }

  @Get('photo-posts/:id') @Roles('teacher', 'admin', 'parent')
  async getPost(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const post = await this.ds.getRepository(PhotoPost).findOne({ where: { id, deletedAt: IsNull() }, relations: { author: true } });
    if (!post) throw NotFound('Không tìm thấy bài đăng');
    await this.assertView(u, post.classId);
    const [v] = await this.views(u, [post]);
    if (!v) throw NotFound('Không tìm thấy bài đăng');
    return v;
  }

  @Get('classes/:classId/photo-posts') @Roles('teacher', 'admin', 'parent')
  async list(@CurrentUser() u: AuthUser, @Param('classId', ParseUUIDPipe) classId: string, @Query() q: PostsQuery) {
    await this.access.getClassOr404(classId);
    await this.assertView(u, classId);
    const limit = q.limit ?? 20;
    const qb = this.ds.getRepository(PhotoPost).createQueryBuilder('p').leftJoinAndSelect('p.author', 'a')
      .where('p.class_id = :classId AND p.deleted_at IS NULL', { classId });
    if (q.before) qb.andWhere('p.createdAt < :b', { b: new Date(q.before) });
    const posts = await qb.orderBy('p.createdAt', 'DESC').take(limit + 1).getMany();
    const page = posts.slice(0, limit);
    return { items: await this.views(u, page), nextBefore: posts.length > limit ? page[page.length - 1].createdAt.toISOString() : null };
  }

  @Delete('photo-posts/:id') @Roles('teacher', 'admin') @HttpCode(204)
  async removePost(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const post = await this.ds.getRepository(PhotoPost).findOne({ where: { id, deletedAt: IsNull() } });
    if (!post) throw NotFound('Không tìm thấy bài đăng');
    if (!(u.role === 'admin' || (post.authorId === u.id && this.isStaff(u, post.classId)))) throw Forbidden('Chỉ người đăng hoặc quản trị được xoá');
    await this.ds.transaction(async (m) => {
      await m.update(PhotoPost, id, { deletedAt: new Date(), deletedBy: u.id });
      await recordAudit(m, u, { action: 'photo_post.delete', entityType: 'photo_post', entityId: id, before: { classId: post.classId, caption: post.caption }, after: null, ip: req.ip });
    });
  }

  @Post('photo-posts/:id/like') @Roles('teacher', 'admin', 'parent') @HttpCode(200)
  async like(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.setLike(u, id, true); }
  @Delete('photo-posts/:id/like') @Roles('teacher', 'admin', 'parent') @HttpCode(200)
  async unlike(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.setLike(u, id, false); }
  private async setLike(u: AuthUser, id: string, on: boolean) {
    const v = await this.getPost(u, id); // 403/404 like viewing
    if (on) await this.ds.query(`INSERT INTO photo_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, u.id]);
    else await this.ds.query(`DELETE FROM photo_likes WHERE post_id = $1 AND user_id = $2`, [id, u.id]);
    const [{ n }] = await this.ds.query(`SELECT COUNT(*)::int n FROM photo_likes WHERE post_id = $1`, [v.id]);
    return { postId: id, likeCount: n, likedByMe: on };
  }

  // ───── photos ─────
  @Get('photos/:id/file') @Roles('teacher', 'admin', 'parent')
  async file(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: FileQuery, @Res() res: Response) {
    const p = await this.loadPhoto(id);
    const staff = this.isStaff(u, p.classId);
    if (!staff && !(await this.parentHasChildInClass(u, p.classId))) throw Forbidden('Chỉ phụ huynh và giáo viên của lớp được xem ảnh');
    if (p.hidden && !staff) throw NotFound('Không tìm thấy ảnh'); // ALB-03: hidden even via direct URL
    const download = q.download === '1';
    if (download && !staff && !p.tags.some((t) => u.childIds.includes(t.childId))) throw Forbidden('Chỉ tải được ảnh có con mình');
    const file = photoPath(q.size === 'thumb' ? p.thumbKey : p.fileKey);
    if (!fs.existsSync(file)) throw NotFound('Không có file ảnh');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (download) res.setHeader('Content-Disposition', `attachment; filename="anh-${p.id.slice(0, 8)}.jpg"`);
    res.sendFile(file);
  }

  private photoState(p: Photo, tags = p.tags.map((t) => t.childId)) {
    return { childIds: tags, hidden: p.hidden, hiddenReason: p.hiddenReason, hiddenForChildIds: p.hiddenForChildIds };
  }

  /** Replace tags. Added children: in class + consent (422). Removing never unhides and never shrinks hiddenForChildIds. */
  @Put('photos/:id/tags') @Roles('teacher', 'admin')
  async setTags(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TagsDto, @Req() req: Request) {
    const p = await this.loadPhoto(id);
    this.assertManage(u, p.classId);
    const next = [...new Set(dto.childIds)], prev = p.tags.map((t) => t.childId);
    const added = next.filter((c) => !prev.includes(c)), removed = prev.filter((c) => !next.includes(c));
    await this.ds.transaction(async (m) => {
      await m.query('SELECT id FROM photos WHERE id = $1 FOR UPDATE', [id]);
      await this.assertInClass(m, p.classId, added);
      await assertConsent(m, added); // ALB-02
      if (removed.length) await m.delete(PhotoTag, { photoId: id, childId: In(removed) });
      if (added.length) await m.save(PhotoTag, added.map((childId) => m.create(PhotoTag, { photoId: id, childId, createdBy: u.id })));
      if (added.length || removed.length) await recordAudit(m, u, { action: 'photo.tags', entityType: 'photo', entityId: id,
        before: this.photoState(p, prev), after: this.photoState(p, next), ip: req.ip, data: { added, removed, classId: p.classId } });
    });
    return this.photoView(u, id);
  }

  /** Unhide: every child in hiddenForChildIds AND every current tag must consent (ALB-07/09). */
  @Post('photos/:id/unhide') @Roles('teacher', 'admin') @HttpCode(200)
  async unhide(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const p = await this.loadPhoto(id);
    this.assertManage(u, p.classId);
    if (!p.hidden) throw new AppError(409, 'NOT_HIDDEN', 'Ảnh đang hiển thị');
    await this.ds.transaction(async (m) => {
      const [cur] = await m.query('SELECT hidden_for_child_ids FROM photos WHERE id = $1 FOR UPDATE', [id]);
      const tags: { child_id: string }[] = await m.query('SELECT child_id FROM photo_tags WHERE photo_id = $1', [id]);
      await assertConsent(m, [...cur.hidden_for_child_ids, ...tags.map((t) => t.child_id)]);
      await m.update(Photo, id, { hidden: false, hiddenReason: null, hiddenForChildIds: [], hiddenAt: null });
      await recordAudit(m, u, { action: 'photo.unhide', entityType: 'photo', entityId: id, before: this.photoState(p),
        after: { ...this.photoState(p), hidden: false, hiddenReason: null, hiddenForChildIds: [] }, ip: req.ip, data: { classId: p.classId } });
    });
    return this.photoView(u, id);
  }

  @Delete('photos/:id') @Roles('teacher', 'admin') @HttpCode(204)
  async removePhoto(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const p = await this.loadPhoto(id);
    if (!(u.role === 'admin' || (p.post.authorId === u.id && this.isStaff(u, p.classId)))) throw Forbidden('Chỉ người đăng hoặc quản trị được xoá');
    await this.ds.transaction(async (m) => {
      await m.update(Photo, id, { deletedAt: new Date(), deletedBy: u.id });
      await recordAudit(m, u, { action: 'photo.delete', entityType: 'photo', entityId: id, before: { postId: p.postId, ...this.photoState(p) }, after: null, ip: req.ip });
    });
  }

  private async photoView(u: AuthUser, id: string) {
    const p = await this.loadPhoto(id);
    const post = await this.ds.getRepository(PhotoPost).findOne({ where: { id: p.postId }, relations: { author: true } });
    const [v] = await this.views(u, [post!]);
    return v.photos.find((x: any) => x.id === id);
  }
}
