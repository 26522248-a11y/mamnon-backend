import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Response } from 'express';
import { DataSource, In, IsNull } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { AppError, BadRequest, Forbidden, NotFound } from '../common/errors';
import { imageUploadOptions, removeImage, saveImage, sendImage } from '../common/upload';
import { AuthorizedPicker, AuthorizedPickerHistory, Child, ChildContactHistory, Guardian, User } from '../database/entities';
import { cleanName, parsePhone, personKey } from '../imports/children-import';
import { audit } from '../common/audit';
import { NotificationsService } from '../notifications/notifications.service';
import { ID_NUMBER_RE, maskId, PickupSafetyService } from './pickup-safety.service';

const CCCD_MSG = 'CCCD phải đúng 12 chữ số';
export class CreatePickerDto {
  @ApiProperty({ example: 'Trần Văn Tư' }) @IsString() @MinLength(1) @MaxLength(120) fullName!: string;
  @ApiProperty({ example: 'Chú ruột' }) @IsString() @MinLength(1) @MaxLength(40) relation!: string;
  @ApiProperty({ example: '079123456789', description: 'CCCD 12 số (bắt buộc)' }) @Matches(ID_NUMBER_RE, { message: CCCD_MSG }) idNumber!: string;
  @ApiProperty({ example: '0912345678', description: 'SĐT liên hệ 1 (bắt buộc)' }) @IsString() phone1!: string;
  @ApiPropertyOptional({ example: '0987654321', description: 'SĐT liên hệ 2' }) @IsOptional() @IsString() phone2?: string;
  @ApiProperty({ type: 'string', format: 'binary', description: 'Ảnh chân dung JPG/PNG (bắt buộc, kiểm tra nội dung file)' }) @IsOptional() photo?: any;
}
export class UpdatePickerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(120) fullName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(40) relation?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(ID_NUMBER_RE, { message: CCCD_MSG }) idNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone1?: string;
  @ApiPropertyOptional({ description: 'Chuỗi rỗng = xoá SĐT 2' }) @IsOptional() @IsString() phone2?: string;
  @ApiPropertyOptional({ type: 'string', format: 'binary' }) @IsOptional() photo?: any;
}
export class PickerDecisionDto { @ApiPropertyOptional({ description: 'Bắt buộc khi từ chối' }) @IsOptional() @IsString() @MaxLength(500) note?: string; }
export class PickerQuery {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'] }) @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
}

const view = (p: AuthorizedPicker & { child?: Child }, names: Map<string, string> = new Map()) => ({
  id: p.id, childId: p.childId, childName: p.child?.fullName, fullName: p.fullName, relation: p.relation, phone1: p.phone1, phone2: p.phone2,
  idNumberMasked: maskId(p.idNumber), photoUrl: `/api/v1/authorized-pickers/${p.id}/photo`,
  status: p.status, onList: p.status === 'approved', decidedBy: p.decidedBy, decidedByName: p.decidedBy ? names.get(p.decidedBy) ?? null : null,
  decidedAt: p.decidedAt, decisionNote: p.decisionNote, createdBy: p.createdBy, createdByName: p.createdBy ? names.get(p.createdBy) ?? null : null, createdAt: p.createdAt, updatedAt: p.updatedAt,
});
const phoneOr400 = (v: string | undefined, field: string) => {
  const p = parsePhone(v ?? '');
  if (!p) throw new AppError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [`${field}: SĐT không hợp lệ (10 số, bắt đầu bằng 0)`]);
  return p;
};
/** fields kept in history (CCCD masked) */
const snap = (p: Partial<AuthorizedPicker>) => ({ fullName: p.fullName, relation: p.relation, idNumber: maskId(p.idNumber ?? null), phone1: p.phone1, phone2: p.phone2, photo: p.photoUrl ? 'set' : undefined, status: p.status });

/**
 * Người đón hộ: registered by a parent for their own child (photo + CCCD + up to 2 phones). Pending until admin approves;
 * pending/rejected count as off-list. CCCD is masked everywhere here (full value only via the audited handover endpoint).
 */
@ApiTags('pickup-safety') @ApiBearerAuth()
@Controller()
export class AuthorizedPickersController {
  constructor(private ds: DataSource, private access: AccessService, private notify: NotificationsService) {}
  private repo() { return this.ds.getRepository(AuthorizedPicker); }
  private async names(rows: AuthorizedPicker[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.decidedBy, r.createdBy]).filter(Boolean) as string[])];
    const us = ids.length ? await this.ds.getRepository(User).find({ where: { id: In(ids) }, select: { id: true, name: true } }) : [];
    return new Map(us.map((x) => [x.id, x.name]));
  }
  private history(pickerId: string, action: string, changes: Record<string, unknown> | null, by: string) {
    return this.ds.getRepository(AuthorizedPickerHistory).insert({ pickerId, action, changes: changes as any, changedBy: by });
  }
  /** read: admin, teacher of the class, parent of the child */
  private async assertRead(u: AuthUser, childId: string) {
    const c = await this.access.getChildOr404(childId);
    if (!this.access.canReadChildDetail(u, c)) throw Forbidden('Không có quyền với trẻ này');
    return c;
  }
  /** write: parent of the child (admin too) */
  private async assertWrite(u: AuthUser, childId: string) {
    const c = await this.access.getChildOr404(childId);
    if (!(u.role === 'admin' || (u.role === 'parent' && u.childIds.includes(childId)))) throw Forbidden('Chỉ phụ huynh của bé được đăng ký người đón hộ');
    return c;
  }
  private async getOr404(id: string) {
    const p = await this.repo().findOne({ where: { id }, relations: { child: true } });
    if (!p || p.deletedAt) throw NotFound('Không tìm thấy người đón hộ');
    return p;
  }

  /** Everyone who may pick the child up: listed guardians (parents) + registered pickers. */
  @Get('children/:id/pickup-people') @Roles('admin', 'teacher', 'parent')
  async people(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertRead(u, id);
    const gs = await this.ds.getRepository(Guardian).find({ where: { childId: id }, order: { createdAt: 'ASC' } });
    const ps = await this.repo().find({ where: { childId: id, deletedAt: IsNull() }, order: { createdAt: 'ASC' } });
    const names = await this.names(ps);
    return {
      childId: id,
      guardians: gs.map((g) => ({ id: g.id, fullName: g.fullName, relation: g.relation, phone: g.phone, idNumberMasked: maskId(g.idNumber), canPickup: g.canPickup, isParentAccount: !!g.userId, onList: g.canPickup })),
      authorizedPickers: ps.map((p) => view(p, names)),
    };
  }

  @Get('children/:id/authorized-pickers') @Roles('admin', 'teacher', 'parent')
  async listForChild(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertRead(u, id);
    const ps = await this.repo().find({ where: { childId: id, deletedAt: IsNull() }, order: { createdAt: 'ASC' } });
    const names = await this.names(ps);
    return ps.map((p) => view(p, names));
  }

  @Post('children/:id/authorized-pickers') @Roles('admin', 'parent')
  @ApiConsumes('multipart/form-data') @UseInterceptors(FileInterceptor('photo', imageUploadOptions))
  async create(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePickerDto, @UploadedFile() file?: Express.Multer.File) {
    const child = await this.assertWrite(u, id);
    if (!file) throw BadRequest('Bắt buộc có ảnh chân dung người đón (JPG/PNG)', 'PHOTO_REQUIRED');
    const phone1 = phoneOr400(dto.phone1, 'phone1');
    const phone2 = dto.phone2?.trim() ? phoneOr400(dto.phone2, 'phone2') : null;
    if (phone2 === phone1) throw BadRequest('SĐT 2 trùng SĐT 1', 'VALIDATION_ERROR');
    if (await this.repo().exist({ where: { childId: id, idNumber: dto.idNumber, deletedAt: IsNull() } })) throw new AppError(409, 'DUPLICATE_PICKER', 'Người này (cùng CCCD) đã có trong danh sách của bé');
    // same rule as the Excel import: same person = same phone + same name (NFC, case/whitespace-insensitive, diacritics kept)
    const samePhone = await this.repo().find({ where: { childId: id, phone1: phone1, deletedAt: IsNull() } });
    if (samePhone.some((x) => personKey(x.fullName) === personKey(dto.fullName))) throw new AppError(409, 'DUPLICATE_PICKER', 'Người này (cùng tên + SĐT) đã có trong danh sách của bé');
    const photo = await saveImage(file); // magic bytes: JPG/PNG/HEIC (-> JPEG), else 400
    const p = await this.repo().save(this.repo().create({ childId: id, fullName: cleanName(dto.fullName), relation: cleanName(dto.relation), idNumber: dto.idNumber, phone1, phone2,
      photoUrl: photo, status: 'pending', createdBy: u.id }));
    await this.history(p.id, 'create', snap(p), u.id);
    const admins = await this.ds.getRepository(User).find({ where: { role: 'admin', isActive: true }, select: { id: true } });
    await this.notify.send(admins.map((a) => a.id), { type: 'picker_registration', refId: p.id, title: `Duyệt người đón hộ cho bé ${child.fullName}`,
      body: `${p.fullName} (${p.relation}), SĐT ${p.phone1} – do ${u.name} đăng ký`, data: { authorizedPickerId: p.id, childId: id } });
    return view({ ...p, child }, await this.names([p]));
  }

  /** Change takes effect immediately; name / CCCD / photo changes send the person back to 'pending' (needs approval again). */
  @Patch('authorized-pickers/:id') @Roles('admin', 'parent')
  @ApiConsumes('multipart/form-data', 'application/json') @UseInterceptors(FileInterceptor('photo', imageUploadOptions))
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePickerDto, @UploadedFile() file?: Express.Multer.File) {
    const p = await this.getOr404(id);
    await this.assertWrite(u, p.childId);
    const before = snap(p);
    const patch: Partial<AuthorizedPicker> = {};
    if (dto.fullName !== undefined) patch.fullName = cleanName(dto.fullName);
    if (dto.relation !== undefined) patch.relation = cleanName(dto.relation);
    if (dto.idNumber !== undefined) patch.idNumber = dto.idNumber;
    if (dto.phone1 !== undefined) patch.phone1 = phoneOr400(dto.phone1, 'phone1');
    if (dto.phone2 !== undefined) patch.phone2 = dto.phone2.trim() ? phoneOr400(dto.phone2, 'phone2') : null;
    let oldPhoto: string | null = null;
    if (file) { oldPhoto = p.photoUrl; patch.photoUrl = await saveImage(file); }
    const identity = (patch.fullName !== undefined && personKey(patch.fullName) !== personKey(p.fullName)) || (patch.idNumber !== undefined && patch.idNumber !== p.idNumber) || !!file;
    if (identity && u.role !== 'admin') Object.assign(patch, { status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null });
    if (!Object.keys(patch).length) throw BadRequest('Không có gì thay đổi', 'NOTHING_TO_UPDATE');
    await this.repo().update(id, patch);
    if (oldPhoto) removeImage(oldPhoto);
    const after = await this.getOr404(id);
    await this.history(id, 'update', { before, after: snap(after), needsApprovalAgain: identity && u.role !== 'admin' }, u.id);
    return view(after, await this.names([after]));
  }

  @Delete('authorized-pickers/:id') @Roles('admin', 'parent') @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.getOr404(id);
    await this.assertWrite(u, p.childId);
    await this.repo().update(id, { deletedAt: new Date(), deletedBy: u.id });
    await this.history(id, 'delete', snap(p), u.id);
    audit('authorized_picker.delete', u, { pickerId: id, childId: p.childId, fullName: p.fullName, idNumber: maskId(p.idNumber) });
  }

  @Get('authorized-pickers/:id/history') @Roles('admin', 'teacher', 'parent')
  async getHistory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.repo().findOne({ where: { id } });
    if (!p) throw NotFound('Không tìm thấy người đón hộ');
    await this.assertRead(u, p.childId);
    const rows = await this.ds.getRepository(AuthorizedPickerHistory).find({ where: { pickerId: id }, relations: { changer: true }, order: { changedAt: 'ASC' } });
    return { id, deleted: !!p.deletedAt, items: rows.map((h) => ({ action: h.action, changes: h.changes, changedBy: h.changedBy, changedByName: h.changer?.name ?? null, changedByRole: h.changer?.role ?? null, changedAt: h.changedAt })) };
  }

  /** admin: all (approval queue, e.g. ?status=pending); teacher: own classes; parent: own children. */
  @Get('authorized-pickers') @Roles('admin', 'teacher', 'parent')
  async list(@CurrentUser() u: AuthUser, @Query() q: PickerQuery) {
    const qb = this.repo().createQueryBuilder('p').leftJoinAndSelect('p.child', 'c').where('p.deleted_at IS NULL').orderBy('p.createdAt', 'DESC').take(500);
    if (u.role === 'teacher') qb.andWhere('c.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('p.child_id = ANY(:kids)', { kids: u.childIds });
    if (q.status) qb.andWhere('p.status = :st', { st: q.status });
    if (q.childId) qb.andWhere('p.child_id = :cid', { cid: q.childId });
    const rows = await qb.getMany();
    const names = await this.names(rows);
    return rows.map((p) => view(p, names));
  }

  private async decide(u: AuthUser, id: string, status: 'approved' | 'rejected', note?: string) {
    const p = await this.getOr404(id);
    if (status === 'rejected' && !note?.trim()) throw BadRequest('Từ chối phải ghi lý do', 'NOTE_REQUIRED');
    if (p.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', 'Người đón hộ này đã được duyệt/từ chối');
    await this.repo().update(id, { status, decidedBy: u.id, decidedAt: new Date(), decisionNote: note?.trim() || null });
    await this.history(id, status === 'approved' ? 'approve' : 'reject', { note: note?.trim() || null }, u.id);
    audit(`authorized_picker.${status === 'approved' ? 'approve' : 'reject'}`, u, { pickerId: id, childId: p.childId, fullName: p.fullName, idNumber: maskId(p.idNumber), note: note?.trim() || null });
    const parents = await this.notify.parentIdsOfChildren([p.childId]);
    await this.notify.send(parents, { type: 'picker_decision', refId: id, title: `Người đón hộ ${p.fullName} ${status === 'approved' ? 'đã được duyệt' : 'bị từ chối'}`,
      body: status === 'approved' ? `${p.fullName} (${p.relation}) có thể đón bé ${p.child.fullName}.` : `Lý do: ${note}`, data: { authorizedPickerId: id, childId: p.childId, status } });
    const after = await this.getOr404(id);
    return view(after, await this.names([after]));
  }
  @Post('authorized-pickers/:id/approve') @Roles('admin') @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PickerDecisionDto) { return this.decide(u, id, 'approved', dto.note); }
  @Post('authorized-pickers/:id/reject') @Roles('admin') @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PickerDecisionDto) { return this.decide(u, id, 'rejected', dto.note); }

  /** Photo: admin, teacher of the class, parent of the child (others 403, no token 401). */
  @Get('authorized-pickers/:id/photo') @Roles('admin', 'teacher', 'parent')
  async photo(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const p = await this.repo().findOne({ where: { id } });
    if (!p) throw NotFound('Không tìm thấy người đón hộ');
    await this.assertRead(u, p.childId);
    sendImage(res, p.photoUrl);
  }
}

export class ContactPhonesDto {
  @ApiProperty({ example: '0912345678', description: 'Số gọi trước (bắt buộc)' }) @IsString() phone1!: string;
  @ApiPropertyOptional({ example: '0987654321', description: 'Số gọi sau; "" hoặc bỏ trống = không có' }) @IsOptional() @IsString() phone2?: string;
}

/**
 * The child's 2 pickup contact phones (called in order by the 15-minute rule). Parents edit them for their own children;
 * takes effect immediately; history kept; admins notified.
 */
@ApiTags('pickup-safety') @ApiBearerAuth()
@Controller('children/:id/contact-phones')
export class ContactPhonesController {
  constructor(private ds: DataSource, private access: AccessService, private notify: NotificationsService, private safety: PickupSafetyService) {}

  private async view(childId: string) {
    const c = await this.ds.getRepository(Child).findOneByOrFail({ id: childId });
    const by = c.contactPhonesUpdatedBy ? await this.ds.getRepository(User).findOne({ where: { id: c.contactPhonesUpdatedBy }, select: { id: true, name: true } }) : null;
    return {
      childId, phone1: c.contactPhone1, phone2: c.contactPhone2, updatedBy: c.contactPhonesUpdatedBy, updatedByName: by?.name ?? null, updatedAt: c.contactPhonesUpdatedAt,
      callOrder: await this.safety.parentPhones(childId),
    };
  }

  @Get() @Roles('admin', 'teacher', 'parent')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.access.getChildOr404(id);
    if (!this.access.canReadChildDetail(u, c)) throw Forbidden('Không có quyền với trẻ này');
    return this.view(id);
  }

  @Patch() @Roles('admin', 'parent')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ContactPhonesDto) {
    const c = await this.access.getChildOr404(id);
    if (!(u.role === 'admin' || (u.role === 'parent' && u.childIds.includes(id)))) throw Forbidden('Chỉ phụ huynh của bé được sửa số liên hệ');
    const phone1 = phoneOr400(dto.phone1, 'phone1');
    const phone2 = dto.phone2?.trim() ? phoneOr400(dto.phone2, 'phone2') : null;
    if (phone2 === phone1) throw new AppError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', ['phone2: trùng phone1']);
    const before = { phone1: c.contactPhone1, phone2: c.contactPhone2 };
    if (before.phone1 === phone1 && before.phone2 === phone2) return this.view(id);
    await this.ds.transaction(async (m) => {
      await m.getRepository(Child).update(id, { contactPhone1: phone1, contactPhone2: phone2, contactPhonesUpdatedBy: u.id, contactPhonesUpdatedAt: new Date() });
      await m.getRepository(ChildContactHistory).insert({ childId: id, before, after: { phone1, phone2 }, changedBy: u.id });
    });
    audit('child.contact_phones', u, { childId: id, before, after: { phone1, phone2 } });
    if (u.role === 'parent') {
      const admins = await this.ds.getRepository(User).find({ where: { role: 'admin', isActive: true }, select: { id: true } });
      await this.notify.send(admins.map((a) => a.id), { type: 'contact_change', refId: id, title: `PH đổi số liên hệ đón bé ${c.fullName}`,
        body: `${u.name}: ${before.phone1 ?? '—'} / ${before.phone2 ?? '—'} → ${phone1} / ${phone2 ?? '—'}`, data: { childId: id, before, after: { phone1, phone2 } } });
    }
    return this.view(id);
  }

  @Get('history') @Roles('admin', 'teacher', 'parent')
  async history(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.access.getChildOr404(id);
    if (!this.access.canReadChildDetail(u, c)) throw Forbidden('Không có quyền với trẻ này');
    const rows = await this.ds.getRepository(ChildContactHistory).find({ where: { childId: id }, relations: { changer: true }, order: { changedAt: 'ASC' } });
    return { childId: id, items: rows.map((h) => ({ before: h.before, after: h.after, changedBy: h.changedBy, changedByName: h.changer?.name ?? null, changedByRole: h.changer?.role ?? null, changedAt: h.changedAt })) };
  }
}
