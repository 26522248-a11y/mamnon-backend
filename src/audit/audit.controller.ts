import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { Roles } from '../common/auth';
import { addDays } from '../common/dates';

export class AuditQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() childId?: string;
  @ApiPropertyOptional({ description: 'Một hoặc nhiều action, cách nhau dấu phẩy; "authorized_picker.*" = theo tiền tố', example: 'guardian.remove,authorized_picker.*' })
  @IsOptional() @IsString() @MaxLength(300) @Matches(/^[a-z0-9_.*,]+$/) action?: string;
  @ApiPropertyOptional({ description: 'actorId (user id)' }) @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional({ description: 'actor username (khớp chính xác)' }) @IsOptional() @IsString() @MaxLength(60) actor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  @ApiPropertyOptional({ description: 'Từ ngày (YYYY-MM-DD, giờ VN, tính cả ngày)' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'Đến ngày (YYYY-MM-DD, giờ VN, tính cả ngày)' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

@ApiTags('audit') @ApiBearerAuth()
@Controller('audit-events')
export class AuditController {
  constructor(private ds: DataSource) {}

  @Get() @Roles('admin')
  @ApiOperation({ summary: 'Nhật ký thao tác nhạy cảm (mới nhất trước), có lọc + phân trang' })
  async list(@Query() q: AuditQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 50;
    const where: string[] = [], p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (q.childId) add('e.child_id = ?', q.childId);
    if (q.actorId) add('e.actor_id = ?', q.actorId);
    if (q.actor) add('e.actor_username = ?', q.actor);
    if (q.entityType) add('e.entity_type = ?', q.entityType);
    if (q.entityId) add('e.entity_id = ?', q.entityId);
    if (q.from) add('e.created_at >= ?', `${q.from.slice(0, 10)}T00:00:00+07:00`);
    if (q.to) add('e.created_at < ?', `${addDays(q.to.slice(0, 10), 1)}T00:00:00+07:00`);
    if (q.action) {
      const parts = q.action.split(',').filter(Boolean);
      const ors: string[] = [];
      for (const a of parts) {
        if (a.endsWith('*')) { p.push(a.slice(0, -1).replace(/[_%]/g, (c) => '\\' + c) + '%'); ors.push(`e.action LIKE $${p.length}`); }
        else { p.push(a); ors.push(`e.action = $${p.length}`); }
      }
      if (ors.length) where.push(`(${ors.join(' OR ')})`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = await this.ds.query(`SELECT COUNT(*)::int AS total FROM audit_events e ${w}`, p);
    const rows: any[] = await this.ds.query(`
      SELECT e.*, u.name AS actor_name, c.full_name AS child_name FROM audit_events e
      LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN children c ON c.id = e.child_id
      ${w} ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, p);
    return {
      total, page, limit,
      items: rows.map((r) => ({
        id: r.id, createdAt: r.created_at, action: r.action, entityType: r.entity_type, entityId: r.entity_id, childId: r.child_id, childName: r.child_name,
        actorId: r.actor_id, actorUsername: r.actor_username, actorName: r.actor_name, actorRole: r.actor_role,
        before: r.before, after: r.after, reason: r.reason, ip: r.ip, data: r.data, source: r.source,
      })),
    };
  }
}
