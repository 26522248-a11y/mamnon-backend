import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { AbsencesService } from '../absences/absences.service';
import { AccessService } from '../common/access';
import { recordAudit } from '../common/audit';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AppError, Forbidden } from '../common/errors';
import { Child, User } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';
import { hidePhotosOfChild } from '../photos/photo-rules';

export class PhotoConsentDto {
  @ApiPropertyOptional({ description: 'Đồng ý chụp/đăng ảnh của bé' }) @IsOptional() @IsBoolean() consent?: boolean;
  @ApiPropertyOptional({ description: 'Alias của consent' }) @IsOptional() @IsBoolean() photoConsent?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Photo consent (default false). Parent: own children only; teacher: read own classes; admin: all. Every change -> audit_events. */
@ApiTags('children')
@ApiBearerAuth()
@Controller('children')
export class PhotoConsentController {
  constructor(private ds: DataSource, private access: AccessService, private absences: AbsencesService, private notify: NotificationsService) {}

  private async child(u: AuthUser, id: string, write: boolean) {
    const c = await this.access.getChildOr404(id);
    const ok = u.role === 'admin' || (u.role === 'parent' && u.childIds.includes(id)) || (!write && u.role === 'teacher' && !!c.classId && u.classIds.includes(c.classId));
    if (!ok) throw Forbidden('Không có quyền với trẻ này');
    return c;
  }

  private async view(c: Child) {
    const by = c.photoConsentUpdatedBy ? await this.ds.getRepository(User).findOne({ where: { id: c.photoConsentUpdatedBy }, select: { id: true, name: true } }) : null;
    const hist: any[] = await this.ds.query(`
      SELECT e.before, e.after, e.actor_id, e.actor_role, e.reason, e.source, e.created_at, u.name
      FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.child_id = $1 AND e.action = 'child.photo_consent' ORDER BY e.created_at DESC LIMIT 100`, [c.id]);
    return {
      childId: c.id, consent: c.photoConsent, photoConsent: c.photoConsent,
      updatedBy: by ? { id: by.id, name: by.name } : null, updatedAt: c.photoConsentUpdatedAt,
      history: hist.map((h) => ({
        before: h.before?.consent ?? null, after: h.after?.consent ?? null,
        by: h.actor_id ? { id: h.actor_id, name: h.name ?? null, role: h.actor_role } : null, at: h.created_at, note: h.reason, source: h.source === 'api' ? (h.after?.source ?? 'api') : h.source,
      })),
    };
  }

  @Get(':id/photo-consent') @Roles('parent', 'teacher', 'admin')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.view(await this.child(u, id, false));
  }

  @Put(':id/photo-consent') @Roles('parent', 'admin')
  async put(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PhotoConsentDto, @Req() req: Request) {
    const consent = dto.consent ?? dto.photoConsent;
    if (consent === undefined) throw new AppError(400, 'VALIDATION_ERROR', 'Thiếu consent', { details: ['consent must be a boolean'] });
    const c = await this.child(u, id, true);
    let hidden: { id: string; classId: string }[] = [];
    if (c.photoConsent !== consent) {
      await this.ds.transaction(async (m) => {
        await m.update(Child, id, { photoConsent: consent, photoConsentUpdatedAt: new Date(), photoConsentUpdatedBy: u.id });
        await recordAudit(m, u, { action: 'child.photo_consent', entityType: 'child', entityId: id, childId: id,
          before: { consent: c.photoConsent }, after: { consent }, reason: dto.note?.trim() || null, ip: req.ip });
        // withdrawn → hide (never delete) every album photo tagging the child, in the same transaction
        if (!consent) hidden = await hidePhotosOfChild(m, u, id, req.ip);
      });
      await this.notify.send(await this.absences.classTeacherIds(c.classId), {
        type: 'photo_consent', title: `${c.fullName}: ${consent ? 'đồng ý' : 'KHÔNG đồng ý'} chụp/đăng ảnh`, data: { childId: id, consent }, refId: id });
      for (const classId of [...new Set(hidden.map((h) => h.classId))]) {
        const n = hidden.filter((h) => h.classId === classId).length;
        await this.notify.send(await this.absences.classTeacherIds(classId), { type: 'photo_hidden', title: `Đã tự ẩn ${n} ảnh có bé ${c.fullName}`,
          body: 'Phụ huynh đã tắt đồng ý đăng ảnh. Ảnh được ẩn khỏi album (không xoá).', data: { childId: id, classId, photoIds: hidden.filter((h) => h.classId === classId).map((h) => h.id) }, refId: id });
      }
    }
    return { ...(await this.view(await this.access.getChildOr404(id))), hiddenPhotos: hidden.length };
  }
}
