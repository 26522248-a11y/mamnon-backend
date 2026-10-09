import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import * as crypto from 'crypto';
import { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { DataSource, EntityManager } from 'typeorm';
import { AccessService } from '../common/access';
import { recordAudit } from '../common/audit';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { storage } from '../common/storage';
import { decodeOriginalName, detectImage, heifToJpeg, sendKey } from '../common/upload';
import { imageQueue } from '../common/image-queue';
import { NotificationsService } from '../notifications/notifications.service';

const MAX_FILES = 20, MAX_BYTES = 15 * 1024 * 1024;
export const photoUploadOptions = { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: MAX_FILES } };
type Kid = { childId: string; name: string };

class ListQuery {
  @ApiPropertyOptional() @IsOptional() @IsISO8601() before?: string;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
class FileQuery {
  @ApiPropertyOptional({ enum: ['thumb', 'full'] }) @IsOptional() @IsIn(['thumb', 'full']) size?: 'thumb' | 'full';
  @ApiPropertyOptional() @IsOptional() @IsIn(['1', 'true']) download?: string;
}
class TagsDto {
  @ApiPropertyOptional({ type: [String] }) @IsArray() @ArrayMaxSize(60) @IsUUID('all', { each: true }) childIds!: string[];
}

const json = <T>(raw: unknown, fallback: T): T => { if (raw === undefined || raw === null || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T } catch { throw BadRequest('Dữ liệu tags/clientIds/hiddenForChildIds không phải JSON hợp lệ', 'VALIDATION_ERROR') } };
const isWebp = (b: Buffer) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
const short = (n: string) => n.trim().split(/\s+/).slice(-2).join(' ');

/**
 * A1 + round3 §2: class photo album.
 * Consent rule (enforced here, not only in the UI): a photo tagging a child whose parents have not allowed photos cannot be posted
 * -> per photo `rejected` / `422 PHOTO_CONSENT_MISSING` with the children's names. The teacher either removes the photo or "hides the child":
 * the child goes into that photo's `hiddenForChildIds`, the photo is saved hidden (parents never see it) until consent + unhide.
 */
@ApiTags('photos')
@ApiBearerAuth()
@Controller()
export class PhotosController {
  constructor(private ds: DataSource, private access: AccessService, private notify: NotificationsService) {}

  private async canView(u: AuthUser, classId: string) {
    if (u.role === 'admin') return true;
    if (u.role === 'teacher') return u.classIds.includes(classId);
    if (u.role === 'parent' && u.childIds.length)
      return (await this.ds.query(`SELECT 1 FROM children WHERE id = ANY($1::uuid[]) AND class_id = $2 LIMIT 1`, [u.childIds, classId])).length > 0;
    return false;
  }
  private assertPost(u: AuthUser, classId: string) {
    if (!(u.role === 'admin' || (u.role === 'teacher' && u.classIds.includes(classId)))) throw Forbidden('Chỉ giáo viên của lớp được đăng ảnh lớp này');
  }
  /** children of the class with consent state */
  private async classKids(classId: string, m: { query: DataSource['query'] } = this.ds): Promise<Map<string, { name: string; consent: boolean; classId: string | null; active: boolean }>> {
    const rows: any[] = await m.query(`SELECT id, full_name, photo_consent, class_id, status FROM children WHERE class_id = $1`, [classId]);
    return new Map(rows.map((r) => [r.id, { name: r.full_name, consent: !!r.photo_consent, classId: r.class_id, active: r.status === 'active' }]));
  }
  private async kidsByIds(ids: string[], m: { query: DataSource['query'] } = this.ds) {
    if (!ids.length) return new Map<string, { name: string; consent: boolean }>();
    const rows: any[] = await m.query(`SELECT id, full_name, photo_consent FROM children WHERE id = ANY($1::uuid[])`, [ids]);
    return new Map(rows.map((r) => [r.id as string, { name: r.full_name as string, consent: !!r.photo_consent }]));
  }

  private photoView(p: any, u: AuthUser, names: Map<string, { name: string }>) {
    const staff = u.role !== 'parent';
    const tags: string[] = p.child_ids ?? [];
    const mineIds = tags.filter((id) => u.childIds.includes(id));
    return {
      id: p.id, width: p.width, height: p.height, clientId: staff ? p.client_id : undefined,
      childIds: staff ? tags : mineIds, mine: u.role === 'parent' ? mineIds.length > 0 : undefined,
      children: (staff ? tags : mineIds).map((id) => ({ childId: id, name: names.get(id)?.name ?? '' })),
      hidden: !!p.hidden, hiddenReason: p.hidden_reason ?? null,
      ...(staff ? { hiddenForChildIds: p.hidden_for_child_ids ?? [], hiddenFor: (p.hidden_for_child_ids ?? []).map((id: string) => ({ childId: id, name: names.get(id)?.name ?? '' })), hiddenAt: p.hidden_at } : {}),
    };
  }
  private async postViews(posts: any[], u: AuthUser) {
    if (!posts.length) return [];
    const ids = posts.map((p) => p.id);
    const photos: any[] = await this.ds.query(`SELECT * FROM photos WHERE post_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY position, created_at`, [ids]);
    const likes: any[] = await this.ds.query(`SELECT post_id, count(*)::int n, bool_or(user_id = $2) me FROM photo_likes WHERE post_id = ANY($1::uuid[]) GROUP BY post_id`, [ids, u.id]);
    const names = await this.kidsByIds([...new Set(photos.flatMap((p) => [...(p.child_ids ?? []), ...(p.hidden_for_child_ids ?? [])]))]);
    const authors = await this.ds.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [[...new Set(posts.map((p) => p.author_id).filter(Boolean))]]);
    const an = new Map<string, string>(authors.map((a: any) => [a.id, a.name]));
    return posts.map((p) => {
      const ph = photos.filter((x) => x.post_id === p.id && (u.role !== 'parent' || !x.hidden));
      const l = likes.find((x) => x.post_id === p.id);
      return { id: p.id, classId: p.class_id, caption: p.caption, createdAt: p.created_at, author: p.author_id ? { id: p.author_id, name: an.get(p.author_id) ?? null } : null,
        likeCount: l?.n ?? 0, likedByMe: !!l?.me, photos: ph.map((x) => this.photoView(x, u, names)) };
    }).filter((p) => u.role !== 'parent' || p.photos.length > 0);
  }

  @Get('classes/:classId/photo-consent-summary') @Roles('teacher', 'admin')
  @ApiOperation({ summary: 'A1: trẻ của lớp + trạng thái đồng ý đăng hình (để GV biết bé nào chưa cho đăng)' })
  async consentSummary(@CurrentUser() u: AuthUser, @Param('classId', ParseUUIDPipe) classId: string) {
    await this.access.getClassOr404(classId); this.assertPost(u, classId);
    const rows: any[] = await this.ds.query(`SELECT id, full_name, photo_consent, photo_consent_updated_at, photo_url FROM children WHERE class_id = $1 AND status = 'active' ORDER BY full_name`, [classId]);
    const items = rows.map((r) => ({ childId: r.id, fullName: r.full_name, photoConsent: !!r.photo_consent, asked: !!r.photo_consent_updated_at, hasAvatar: !!r.photo_url }));
    return { items, notAllowed: items.filter((x) => !x.photoConsent) };
  }

  @Get('classes/:classId/photo-posts') @Roles('teacher', 'admin', 'parent')
  async list(@CurrentUser() u: AuthUser, @Param('classId', ParseUUIDPipe) classId: string, @Query() q: ListQuery) {
    await this.access.getClassOr404(classId);
    if (!(await this.canView(u, classId))) throw Forbidden('Không có quyền xem ảnh lớp này');
    const limit = q.limit ?? 20;
    const posts: any[] = await this.ds.query(`SELECT * FROM photo_posts WHERE class_id = $1 AND deleted_at IS NULL ${q.before ? 'AND created_at < $3' : ''}
      ORDER BY created_at DESC LIMIT $2`, q.before ? [classId, limit + 1, q.before] : [classId, limit + 1]);
    const page = posts.slice(0, limit);
    return { items: await this.postViews(page, u), nextBefore: posts.length > limit ? new Date(page[page.length - 1].created_at).toISOString() : null };
  }

  @Post('classes/:classId/photo-posts') @Roles('teacher', 'admin')
  @ApiConsumes('multipart/form-data') @UseInterceptors(FilesInterceptor('files', MAX_FILES, photoUploadOptions))
  @ApiOperation({ summary: 'Đăng ảnh lớp. tags / clientIds / hiddenForChildIds = JSON mảng theo thứ tự files. Ảnh gắn bé chưa đồng ý mà không ẩn bé → bị từ chối (PHOTO_CONSENT_MISSING); bé nằm trong hiddenForChildIds → ảnh lưu ở trạng thái ẩn.' })
  async create(@CurrentUser() u: AuthUser, @Param('classId', ParseUUIDPipe) classId: string, @UploadedFiles() files: Express.Multer.File[], @Body() body: any, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.access.getClassOr404(classId); this.assertPost(u, classId);
    files = files ?? [];
    if (!files.length) throw BadRequest('Chưa chọn ảnh nào', 'VALIDATION_ERROR');
    const caption = typeof body?.caption === 'string' ? body.caption.trim().slice(0, 300) || null : null;
    const tags = json<string[][]>(body?.tags, []), clientIds = json<(string | null)[]>(body?.clientIds, []), hiddenFor = json<string[][]>(body?.hiddenForChildIds, []);
    if (!Array.isArray(tags) || !Array.isArray(clientIds) || !Array.isArray(hiddenFor)) throw BadRequest('tags/clientIds/hiddenForChildIds phải là mảng', 'VALIDATION_ERROR');
    const kids = await this.classKids(classId);
    const uuid = /^[0-9a-f-]{36}$/i;
    const plan = files.map((f, i) => {
      const t = [...new Set([...(Array.isArray(tags[i]) ? tags[i] : []), ...(Array.isArray(hiddenFor[i]) ? hiddenFor[i] : [])].map(String))];
      const bad = t.filter((id) => !uuid.test(id) || !kids.get(id)?.active);
      if (bad.length) throw new AppError(400, 'CHILD_NOT_IN_CLASS', 'Có bé không thuộc lớp này', { childIds: bad, file: decodeOriginalName(f.originalname) });
      const kind = isWebp(f.buffer) ? 'webp' : detectImage(f.buffer);
      if (!kind) throw new AppError(400, 'UNSUPPORTED_IMAGE', `Tệp không phải ảnh hợp lệ: ${decodeOriginalName(f.originalname)}`, { fileName: decodeOriginalName(f.originalname) });
      const hide = (Array.isArray(hiddenFor[i]) ? hiddenFor[i] : []).map(String).filter((id) => !kids.get(id)?.consent);
      const missing = t.filter((id) => !kids.get(id)!.consent && !hide.includes(id)).map((id) => ({ childId: id, name: kids.get(id)!.name }));
      const cid = typeof clientIds[i] === 'string' && clientIds[i] ? String(clientIds[i]).slice(0, 80) : null;
      return { f, i, kind, tags: t, hide, missing, clientId: cid };
    });
    // duplicates (retry with the same clientId) return the existing photo
    const cids = plan.map((p) => p.clientId).filter(Boolean) as string[];
    const existing: any[] = cids.length ? await this.ds.query(`SELECT * FROM photos WHERE author_id = $1 AND client_id = ANY($2::varchar[]) AND deleted_at IS NULL`, [u.id, cids]) : [];
    const results: any[] = []; const toSave = [] as (typeof plan[number] & { full: Buffer; thumb: Buffer; w: number; h: number })[];
    const sharp = require('sharp');
    for (const p of plan) {
      const dup = p.clientId ? existing.find((x) => x.client_id === p.clientId) : null;
      if (dup) { results.push({ index: p.i, clientId: p.clientId, file: decodeOriginalName(p.f.originalname), status: 'created', duplicate: true, photoId: dup.id }); continue; }
      if (p.missing.length) { results.push({ index: p.i, clientId: p.clientId, file: decodeOriginalName(p.f.originalname), status: 'rejected', code: 'PHOTO_CONSENT_MISSING', children: p.missing }); continue; }
      try {
        // B31: one image at a time through the shared queue (memory on Render Free); 503 when the queue is full
        const { full, thumb } = await imageQueue().run(async () => {
          const buf = p.kind === 'heif' ? await heifToJpeg(p.f.buffer) : p.f.buffer;
          const full = await sharp(buf).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
          const thumb = await sharp(buf).rotate().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
          return { full, thumb };
        });
        toSave.push({ ...p, full: full.data, thumb, w: full.info.width, h: full.info.height });
      } catch (e) { if (e instanceof AppError && e.code === 'IMAGE_QUEUE_FULL') throw e; results.push({ index: p.i, clientId: p.clientId, file: decodeOriginalName(p.f.originalname), status: 'rejected', code: 'UNSUPPORTED_IMAGE' }); }
    }
    const allMissing = (): Kid[] => { const m = new Map<string, Kid>(); plan.forEach((p) => p.missing.forEach((k) => m.set(k.childId, k))); return [...m.values()]; };
    if (!toSave.length && !results.some((r) => r.duplicate)) {
      const kidsMissing = allMissing();
      if (kidsMissing.length) throw new AppError(422, 'PHOTO_CONSENT_MISSING',
        `Chưa đăng được: phụ huynh của ${kidsMissing.map((k) => short(k.name)).join(', ')} chưa cho đăng hình. Bỏ ảnh có bé hoặc ẩn bé rồi đăng lại.`, { children: kidsMissing, results: results.sort((a, b) => a.index - b.index) });
      throw new AppError(400, 'UNSUPPORTED_IMAGE', 'Không đọc được ảnh nào', { results });
    }
    let postId: string | null = null;
    if (toSave.length) {
      const st = storage(); const keys: string[] = [];
      try {
        for (const p of toSave) {
          const id = crypto.randomUUID();
          (p as any).id = id; (p as any).fullKey = `photos/${classId}/${id}-full.jpg`; (p as any).thumbKey = `photos/${classId}/${id}-thumb.jpg`;
          await st.put((p as any).fullKey, p.full, 'image/jpeg'); keys.push((p as any).fullKey);
          await st.put((p as any).thumbKey, p.thumb, 'image/jpeg'); keys.push((p as any).thumbKey);
        }
        postId = await this.ds.transaction(async (m) => {
          const [post] = await m.query(`INSERT INTO photo_posts (class_id, author_id, caption) VALUES ($1,$2,$3) RETURNING id`, [classId, u.id, caption]);
          for (const p of toSave) {
            const hidden = p.hide.length > 0;
            await m.query(`INSERT INTO photos (id, post_id, class_id, author_id, client_id, full_key, thumb_key, width, height, child_ids, hidden, hidden_reason, hidden_for_child_ids, hidden_at, position)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11,$12,$13::uuid[],$14,$15)`,
              [(p as any).id, post.id, classId, u.id, p.clientId, (p as any).fullKey, (p as any).thumbKey, p.w, p.h, p.tags, hidden, hidden ? 'CONSENT_MISSING' : null, p.hide, hidden ? new Date() : null, p.i]);
            results.push({ index: p.i, clientId: p.clientId, file: decodeOriginalName(p.f.originalname), status: 'created', photoId: (p as any).id, hidden });
          }
          await recordAudit(m, u, { action: 'photo_post.create', entityType: 'photo_post', entityId: post.id, ip: req.ip,
            after: { classId, photos: toSave.map((p) => ({ id: (p as any).id, childIds: p.tags, hiddenForChildIds: p.hide })) } });
          return post.id as string;
        });
      } catch (e: any) {
        await Promise.all(keys.map((k) => st.remove(k).catch(() => undefined)));
        if (e?.driverError?.code === '23505') throw new AppError(409, 'CLIENT_ID_CONFLICT', 'Ảnh này đang được gửi, thử lại');
        throw e;
      }
      if (toSave.some((p) => !p.hide.length)) {
        const parents: string[] = (await this.ds.query(`SELECT DISTINCT g.user_id FROM guardians g JOIN children c ON c.id = g.child_id
          WHERE c.class_id = $1 AND c.status = 'active' AND g.user_id IS NOT NULL`, [classId])).map((r: any) => r.user_id);
        const n = toSave.filter((p) => !p.hide.length).length;
        if (parents.length) await this.notify.send(parents, { type: 'photo_post', refId: postId, title: `📸 Lớp có ${n} ảnh mới`, body: caption ?? 'Cô vừa đăng ảnh lên nhóm lớp',
          data: { postId, classId, url: '/photos' } } as any);
      }
    }
    const post = postId ? (await this.postViews(await this.ds.query(`SELECT * FROM photo_posts WHERE id = $1`, [postId]), u))[0] : null;
    res.status(201);
    return { ...(post ?? { id: null, classId, caption, photos: [] }), results: results.sort((a, b) => a.index - b.index) };
  }

  private async photoOr404(id: string) {
    const [p] = await this.ds.query(`SELECT * FROM photos WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!p) throw NotFound('Không tìm thấy ảnh');
    return p;
  }

  @Get('photos/:id/file') @Roles('teacher', 'admin', 'parent')
  async file(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: FileQuery, @Res() res: Response) {
    const p = await this.photoOr404(id);
    if (!(await this.canView(u, p.class_id))) throw Forbidden('Không có quyền xem ảnh này');
    if (u.role === 'parent' && p.hidden) throw NotFound('Không tìm thấy ảnh');
    const download = !!q.download;
    if (download && u.role === 'parent' && !(p.child_ids ?? []).some((c: string) => u.childIds.includes(c))) throw Forbidden('Chỉ tải được ảnh có con mình');
    // B31: keys are per-upload UUIDs → immutable + ETag (304 without a storage read); checks above always run first
    await sendKey(res, q.size === 'full' || download ? p.full_key : p.thumb_key, { mode: 'immutable', notFound: 'Không tìm thấy tệp ảnh', contentType: 'image/jpeg',
      extra: download ? { 'Content-Disposition': `attachment; filename="anh-lop-${id.slice(0, 8)}.jpg"` } : {} });
  }

  @Put('photos/:id/tags') @Roles('teacher', 'admin')
  async setTags(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TagsDto, @Req() req: Request) {
    const p = await this.photoOr404(id); this.assertPost(u, p.class_id);
    const kids = await this.classKids(p.class_id);
    const next = [...new Set(dto.childIds)];
    const bad = next.filter((c) => !kids.get(c)?.active && !(p.child_ids ?? []).includes(c));
    if (bad.length) throw new AppError(400, 'CHILD_NOT_IN_CLASS', 'Có bé không thuộc lớp này', { childIds: bad });
    const added = next.filter((c) => !(p.child_ids ?? []).includes(c));
    const missing = added.filter((c) => !kids.get(c)?.consent && !(p.hidden_for_child_ids ?? []).includes(c)).map((c) => ({ childId: c, name: kids.get(c)?.name ?? '' }));
    if (missing.length) throw new AppError(422, 'PHOTO_CONSENT_MISSING', `Phụ huynh của ${missing.map((k) => short(k.name)).join(', ')} chưa cho đăng hình, không gắn tên được`, { children: missing });
    await this.ds.transaction(async (m) => {
      await m.query(`UPDATE photos SET child_ids = $2::uuid[] WHERE id = $1`, [id, next]);
      await recordAudit(m, u, { action: 'photo.tags', entityType: 'photo', entityId: id, ip: req.ip,
        before: { childIds: p.child_ids, hidden: p.hidden, hiddenForChildIds: p.hidden_for_child_ids }, after: { childIds: next, hidden: p.hidden } });
    });
    return this.single(id, u);
  }

  @Post('photos/:id/unhide') @Roles('teacher', 'admin') @HttpCode(200)
  async unhide(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const p = await this.photoOr404(id); this.assertPost(u, p.class_id);
    const need = [...new Set([...(p.hidden_for_child_ids ?? []), ...(p.child_ids ?? [])])];
    const kids = await this.kidsByIds(need);
    const missing = need.filter((c) => !kids.get(c)?.consent).map((c) => ({ childId: c, name: kids.get(c)?.name ?? '' }));
    if (missing.length) throw new AppError(422, 'PHOTO_CONSENT_MISSING', `Chưa bỏ ẩn được: phụ huynh của ${missing.map((k) => short(k.name)).join(', ')} chưa cho đăng hình`, { children: missing });
    await this.ds.transaction(async (m) => {
      await m.query(`UPDATE photos SET hidden = false, hidden_reason = NULL, hidden_for_child_ids = '{}', hidden_at = NULL WHERE id = $1`, [id]);
      await recordAudit(m, u, { action: 'photo.unhide', entityType: 'photo', entityId: id, ip: req.ip, before: { hidden: p.hidden, hiddenReason: p.hidden_reason, hiddenForChildIds: p.hidden_for_child_ids } });
    });
    return this.single(id, u);
  }

  private async single(id: string, u: AuthUser) {
    const [p] = await this.ds.query(`SELECT * FROM photos WHERE id = $1`, [id]);
    return this.photoView(p, u, await this.kidsByIds([...(p.child_ids ?? []), ...(p.hidden_for_child_ids ?? [])]));
  }

  @Delete('photos/:id') @Roles('teacher', 'admin') @HttpCode(204)
  async removePhoto(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const p = await this.photoOr404(id); this.assertPost(u, p.class_id);
    if (u.role !== 'admin' && p.author_id !== u.id) throw Forbidden('Chỉ người đăng hoặc Ban giám hiệu xoá được ảnh');
    await this.ds.transaction(async (m) => {
      await m.query(`UPDATE photos SET deleted_at = now() WHERE id = $1`, [id]);
      await recordAudit(m, u, { action: 'photo.delete', entityType: 'photo', entityId: id, ip: req.ip, before: { childIds: p.child_ids, postId: p.post_id } });
    });
  }

  @Delete('photo-posts/:id') @Roles('teacher', 'admin') @HttpCode(204)
  async removePost(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const [p] = await this.ds.query(`SELECT * FROM photo_posts WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!p) throw NotFound('Không tìm thấy bài đăng');
    this.assertPost(u, p.class_id);
    if (u.role !== 'admin' && p.author_id !== u.id) throw Forbidden('Chỉ người đăng hoặc Ban giám hiệu xoá được bài');
    await this.ds.transaction(async (m) => {
      await m.query(`UPDATE photo_posts SET deleted_at = now() WHERE id = $1`, [id]);
      await m.query(`UPDATE photos SET deleted_at = now() WHERE post_id = $1 AND deleted_at IS NULL`, [id]);
      await recordAudit(m, u, { action: 'photo_post.delete', entityType: 'photo_post', entityId: id, ip: req.ip });
    });
  }

  private async postForLike(u: AuthUser, id: string) {
    const [p] = await this.ds.query(`SELECT * FROM photo_posts WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!p || !(await this.canView(u, p.class_id))) throw NotFound('Không tìm thấy bài đăng');
  }
  @Post('photo-posts/:id/like') @Roles('teacher', 'admin', 'parent') @HttpCode(204)
  async like(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.postForLike(u, id);
    await this.ds.query(`INSERT INTO photo_likes (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
  }
  @Delete('photo-posts/:id/like') @Roles('teacher', 'admin', 'parent') @HttpCode(204)
  async unlike(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.postForLike(u, id);
    await this.ds.query(`DELETE FROM photo_likes WHERE post_id = $1 AND user_id = $2`, [id, u.id]);
  }
}

/** Consent turned off -> hide every photo tagging the child (same transaction as the consent change). Returns photo ids hidden now. */
export async function hidePhotosForChild(m: EntityManager, childId: string): Promise<string[]> {
  const res: any = await m.query(`UPDATE photos SET hidden = true, hidden_reason = COALESCE(hidden_reason, 'CONSENT_WITHDRAWN'), hidden_at = COALESCE(hidden_at, now()),
      hidden_for_child_ids = CASE WHEN $1 = ANY(hidden_for_child_ids) THEN hidden_for_child_ids ELSE array_append(hidden_for_child_ids, $1::uuid) END
    WHERE $1 = ANY(child_ids) AND deleted_at IS NULL AND NOT ($1 = ANY(hidden_for_child_ids)) RETURNING id`, [childId]);
  // TypeORM/pg returns [rows, affected] for UPDATE … RETURNING
  const rows: any[] = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res;
  return rows.map((r) => r.id);
}
