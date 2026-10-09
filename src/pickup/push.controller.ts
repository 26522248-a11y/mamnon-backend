import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, IsUrl, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser, Public, Roles, AllowWhenPasswordChangeRequired } from '../common/auth';
import { AppError, Forbidden, NotFound } from '../common/errors';
import { sendImage } from '../common/upload';
import { Guardian, PickupRequest, PushSubscription, User } from '../database/entities';
import { NotificationDispatcher, vapidConfigured } from '../notifications/channels';
import { NotificationsService } from '../notifications/notifications.service';
import { PickupSafetyService } from './pickup-safety.service';
import { requestBlockers } from './request-rules';

class SubKeys { @IsString() @MaxLength(200) p256dh!: string; @IsString() @MaxLength(100) auth!: string; }
export class SubscribeDto {
  @ApiProperty({ description: 'PushSubscription.endpoint' }) @IsUrl({ require_tld: false, protocols: ['https', 'http'] }) @MaxLength(1000) endpoint!: string;
  @ApiProperty({ example: { p256dh: 'B...', auth: '...' } }) @IsObject() @ValidateNested() @Type(() => SubKeys) keys!: SubKeys;
}
export class UnsubscribeDto { @ApiProperty() @IsString() @MaxLength(1000) endpoint!: string; }
export class PushActionDto {
  @ApiProperty({ description: 'data.actionToken from the push payload' }) @IsString() @MaxLength(2000) token!: string;
  @ApiProperty({ enum: ['confirm', 'reject'] }) @IsIn(['confirm', 'reject']) action!: 'confirm' | 'reject';
  @ApiPropertyOptional() @IsOptional() @IsUUID() requestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@ApiTags('push') @ApiBearerAuth()
@Controller('push')
export class PushController {
  constructor(private ds: DataSource, private safety: PickupSafetyService, private dispatcher: NotificationDispatcher, private notify: NotificationsService) {}

  @Public() @Get('vapid-public-key')
  key() { return { publicKey: process.env.VAPID_PUBLIC_KEY || null, enabled: vapidConfigured(), channels: this.dispatcher.status() }; }

  /** Register / refresh this browser's subscription (endpoint unique; re-subscribing moves it to the current user). */
  @AllowWhenPasswordChangeRequired() @Post('subscriptions') @Roles('admin', 'teacher', 'parent', 'accountant')
  async subscribe(@CurrentUser() u: AuthUser, @Body() dto: SubscribeDto, @Res({ passthrough: true }) res: Response) {
    if (!dto.keys?.p256dh || !dto.keys?.auth) throw new AppError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', ['keys.p256dh, keys.auth bắt buộc']);
    const ua = (res.req.headers['user-agent'] ?? '').toString().slice(0, 300) || null;
    await this.ds.createQueryBuilder().insert().into(PushSubscription)
      .values({ userId: u.id, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth, userAgent: ua, failCount: 0 })
      .orUpdate(['user_id', 'p256dh', 'auth', 'user_agent', 'fail_count'], ['endpoint']).execute();
    const s = await this.ds.getRepository(PushSubscription).findOneByOrFail({ endpoint: dto.endpoint });
    return { id: s.id, endpoint: s.endpoint, createdAt: s.createdAt };
  }

  @AllowWhenPasswordChangeRequired() @Get('subscriptions') @Roles('admin', 'teacher', 'parent', 'accountant')
  async list(@CurrentUser() u: AuthUser) {
    const rows = await this.ds.getRepository(PushSubscription).find({ where: { userId: u.id }, order: { createdAt: 'DESC' } });
    return rows.map((s) => ({ id: s.id, endpoint: s.endpoint, userAgent: s.userAgent, createdAt: s.createdAt, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError, failCount: s.failCount }));
  }

  @AllowWhenPasswordChangeRequired() @Delete('subscriptions') @Roles('admin', 'teacher', 'parent', 'accountant') @HttpCode(204)
  async unsubscribe(@CurrentUser() u: AuthUser, @Body() dto: UnsubscribeDto) {
    await this.ds.getRepository(PushSubscription).delete({ userId: u.id, endpoint: dto.endpoint });
  }

  @Post('test') @Roles('admin', 'teacher', 'parent', 'accountant') @HttpCode(200)
  async test(@CurrentUser() u: AuthUser) {
    const r = await this.notify.send([u.id], { type: 'announcement', title: 'Thử thông báo', body: 'Thông báo đẩy hoạt động bình thường.', push: { url: '/', tag: 'push-test' } }, { only: ['webpush'] });
    return { results: r };
  }

  /**
   * Service-worker notification action (no login session: the signed short-lived token from the payload authenticates).
   * Records the PARENT step (channel 'push'). The token is bound to one request + one parent; the parent must still be
   * an active parent of the child. Expired -> 409, forged -> 403, already answered -> 409.
   */
  @Public() @Post('actions') @HttpCode(200)
  @ApiOperation({ summary: 'Xác nhận / từ chối yêu cầu đón từ nút trên thông báo đẩy (token ký trong payload)' })
  async action(@Body() dto: PushActionDto) {
    const { rid, uid } = this.safety.verifyAction(dto.token, dto.requestId);
    const user = await this.ds.getRepository(User).findOne({ where: { id: uid } });
    const r = await this.ds.getRepository(PickupRequest).findOne({ where: { id: rid } });
    if (!user || !user.isActive || user.role !== 'parent' || !r) throw new AppError(403, 'INVALID_ACTION_TOKEN', 'Liên kết xác nhận không hợp lệ');
    if (!(await this.ds.getRepository(Guardian).exist({ where: { userId: uid, childId: r.childId } }))) throw Forbidden('Không còn là phụ huynh của bé');
    const done = await this.safety.decideStep(user, rid, 'parent', dto.action === 'confirm' ? 'approved' : 'rejected', { note: dto.note, channel: 'push' });
    return { id: done.id, status: done.status, parentStatus: done.parentStatus, schoolStatus: done.schoolStatus, blockers: requestBlockers(done),
      message: dto.action === 'confirm' ? 'Đã xác nhận. Nhà trường sẽ duyệt trước khi giao bé.' : 'Đã từ chối: bé sẽ không được giao cho người này.' };
  }

  /** Picker photo for the notification image (token-checked; no session in the SW context). */
  @Public() @Get('pickup-photo/:id')
  async photo(@Param('id', ParseUUIDPipe) id: string, @Query('t') t: string, @Res() res: Response) {
    if (!t) throw new AppError(403, 'INVALID_ACTION_TOKEN', 'Thiếu token');
    this.safety.verifyAction(t, id);
    const r = await this.ds.getRepository(PickupRequest).findOne({ where: { id } });
    if (!r) throw NotFound('Không tìm thấy yêu cầu đón');
    await sendImage(res, r.photoUrl);
  }
}
