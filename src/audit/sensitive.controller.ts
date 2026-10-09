import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { Roles } from '../common/auth';
import { addDays } from '../common/dates';
import { csvCell, describe, maskPhones, phoneSlots, SENSITIVE_TYPES, SensitiveType, TYPE_ACTIONS, TYPE_LABELS, actionType } from './sensitive';

export class SensitiveQuery {
  @ApiPropertyOptional({ description: 'guardian_unlink | phone_change | photo_consent (có thể nhiều, cách nhau dấu phẩy). Bỏ trống = tất cả' })
  @IsOptional() @IsString() @Matches(/^(guardian_unlink|phone_change|photo_consent)(,(guardian_unlink|phone_change|photo_consent))*$/, { message: 'type: guardian_unlink | phone_change | photo_consent' })
  type?: string;
  @ApiPropertyOptional({ description: 'Từ ngày (YYYY-MM-DD, giờ VN, tính cả ngày)' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'Đến ngày (YYYY-MM-DD, giờ VN, tính cả ngày)' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ description: 'Tìm theo tên bé / đối tượng / người sửa (không phân biệt dấu)' }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

const EXPORT_MAX = 10000;
const vnTime = (d: Date) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

/**
 * B18 – Lịch sử thay đổi nhạy cảm (admin only, read-only): guardian unlink, phone change, photo consent change.
 * Rows come from audit_events (written in the same transaction as the change). Phones are masked in the middle.
 */
@ApiTags('audit') @ApiBearerAuth()
@Controller('audit/sensitive') @Roles('admin')
export class SensitiveAuditController {
  constructor(private ds: DataSource) {}

  private where(q: SensitiveQuery, withType: boolean) {
    const p: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    const types = withType && q.type ? (q.type.split(',') as SensitiveType[]) : [...SENSITIVE_TYPES];
    add('e.action = ANY(?)', types.flatMap((t) => TYPE_ACTIONS[t]));
    if (q.from) add('e.created_at >= ?', `${q.from.slice(0, 10)}T00:00:00+07:00`);
    if (q.to) add('e.created_at < ?', `${addDays(q.to.slice(0, 10), 1)}T00:00:00+07:00`);
    if (q.q?.trim()) {
      p.push(`%${q.q.trim().replace(/[%_\\]/g, '\\$&')}%`);
      const n = `$${p.length}`;
      where.push(`(unaccent(COALESCE(e.target_label, c.full_name, '')) ILIKE unaccent(${n}) OR unaccent(COALESCE(e.actor_name, u.name, '')) ILIKE unaccent(${n})
        OR e.actor_username ILIKE ${n} OR unaccent(COALESCE(e.before->>'fullName', '')) ILIKE unaccent(${n}))`);
    }
    return { sql: `FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN children c ON c.id = e.child_id WHERE ${where.join(' AND ')}`, p };
  }

  private async rows(q: SensitiveQuery, limit: number, offset: number) {
    const w = this.where(q, true);
    const rows: any[] = await this.ds.query(`SELECT e.id, e.created_at, e.action, e.entity_type, e.entity_id, e.child_id, e.before, e.after, e.reason, e.ip,
        e.actor_id, e.actor_username, e.actor_role, COALESCE(e.actor_name, u.name) AS actor_name, COALESCE(e.target_label, c.full_name) AS target_label, c.full_name AS child_name
      ${w.sql} ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`, w.p);
    return rows.map((r) => {
      const before = maskPhones(r.before), after = maskPhones(r.after);
      const type = actionType(r.action)!;
      return {
        id: r.id, createdAt: r.created_at, type, typeLabel: TYPE_LABELS[type], action: r.action,
        target: { entity: r.entity_type, id: r.entity_id, label: r.target_label ?? null, childId: r.child_id, childName: r.child_name ?? null },
        before, after, ...describe(r.action, before, after), afterPhones: phoneSlots(r.action, r.before, r.after), reason: r.reason,
        actor: { id: r.actor_id, name: r.actor_name ?? null, username: r.actor_username, role: r.actor_role,
          self: r.action === 'child.contact_phones' && r.actor_role === 'parent' },
        ip: r.ip,
      };
    });
  }

  @Get()
  @ApiOperation({ summary: 'Lịch sử thay đổi nhạy cảm (mới nhất trước): gỡ liên kết PH, đổi SĐT, đổi đồng ý ảnh. SĐT che giữa.' })
  async list(@Query() q: SensitiveQuery) {
    const page = q.page ?? 1, limit = q.limit ?? 20;
    const w = this.where(q, true);
    const [{ total }] = await this.ds.query(`SELECT COUNT(*)::int AS total ${w.sql}`, w.p);
    // chip counts: same date range / search, every type
    const wa = this.where(q, false);
    const byAction: { action: string; n: number }[] = await this.ds.query(`SELECT e.action, COUNT(*)::int AS n ${wa.sql} GROUP BY e.action`, wa.p);
    const counts: Record<string, number> = { all: 0, guardian_unlink: 0, phone_change: 0, photo_consent: 0 };
    for (const r of byAction) { const t = actionType(r.action); if (t) { counts[t] += r.n; counts.all += r.n; } }
    return { total, page, limit, counts, items: await this.rows(q, limit, (page - 1) * limit) };
  }

  @Get('export')
  @ApiOperation({ summary: `Xuất CSV (UTF-8 BOM, cùng bộ lọc, tối đa ${EXPORT_MAX} dòng, SĐT che giữa)` })
  async export(@Query() q: SensitiveQuery, @Res() res: Response) {
    const items = await this.rows(q, EXPORT_MAX, 0);
    const head = ['Thời gian', 'Loại', 'Đối tượng', 'Trước', 'Sau', 'Lý do', 'Người sửa', 'Tên đăng nhập', 'Vai trò', 'IP'];
    const lines = items.map((i) => [vnTime(new Date(i.createdAt)), i.typeLabel, i.target.label, i.beforeText, i.afterText, i.reason,
      i.actor.name, i.actor.username, i.actor.role, i.ip].map(csvCell).join(','));
    const name = `lich-su-thay-doi_${q.from ?? 'all'}_${q.to ?? 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('\uFEFF' + [head.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n');
  }
}
