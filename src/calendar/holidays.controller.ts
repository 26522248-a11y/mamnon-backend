import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DataSource, In } from 'typeorm';
import { AbsencesService } from '../absences/absences.service';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { addDays, dayDiff } from '../common/dates';
import { AppError, BadRequest, NotFound } from '../common/errors';
import { Holiday, User } from '../database/entities';

/** Lunar new year (mùng 1 Tết) and Giỗ Tổ (10/3 âm lịch), solar dates computed with a lunar calendar. */
const LUNAR: Record<number, { tet: string; gioTo: string }> = {
  2025: { tet: '2025-01-29', gioTo: '2025-04-07' },
  2026: { tet: '2026-02-17', gioTo: '2026-04-26' },
  2027: { tet: '2027-02-06', gioTo: '2027-04-16' },
  2028: { tet: '2028-01-26', gioTo: '2028-04-04' },
  2029: { tet: '2029-02-13', gioTo: '2029-04-23' },
  2030: { tet: '2030-02-03', gioTo: '2030-04-12' },
};
type TemplateItem = { date: string; name: string; status: 'pending' | 'confirmed' };
export function nationalTemplate(year: number): TemplateItem[] {
  const l = LUNAR[year];
  if (!l) throw new AppError(400, 'TEMPLATE_YEAR_UNSUPPORTED', `Chưa có mẫu ngày lễ cho năm ${year}`, { supported: Object.keys(LUNAR).map(Number) });
  const solar: TemplateItem[] = [
    { date: `${year}-01-01`, name: 'Tết Dương lịch', status: 'confirmed' },
    { date: `${year}-04-30`, name: 'Ngày Giải phóng miền Nam 30/4', status: 'confirmed' },
    { date: `${year}-05-01`, name: 'Quốc tế Lao động 1/5', status: 'confirmed' },
    { date: `${year}-09-01`, name: 'Quốc khánh (nghỉ kèm)', status: 'confirmed' },
    { date: `${year}-09-02`, name: 'Quốc khánh 2/9', status: 'confirmed' },
  ];
  const tet = [-1, 0, 1, 2, 3].map((o) => ({ date: addDays(l.tet, o), name: o < 0 ? 'Tết Nguyên đán (30 Tết)' : `Tết Nguyên đán (mùng ${o + 1})`, status: 'pending' as const }));
  return [...solar, ...tet, { date: l.gioTo, name: 'Giỗ Tổ Hùng Vương 10/3 âm lịch', status: 'pending' as const }].sort((a, b) => a.date.localeCompare(b.date));
}

export class HolidayQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ enum: ['pending', 'confirmed'] }) @IsOptional() @IsIn(['pending', 'confirmed']) status?: 'pending' | 'confirmed';
}
export class CreateHolidayDto {
  @ApiProperty({ example: '2026-11-20' }) @IsDateString() date!: string;
  @ApiPropertyOptional({ description: 'Ngày kết thúc (nghỉ nhiều ngày)' }) @IsOptional() @IsDateString() to?: string;
  @ApiProperty({ example: 'Ngày Nhà giáo VN' }) @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @ApiPropertyOptional({ enum: ['national', 'school'], default: 'school' }) @IsOptional() @IsIn(['national', 'school']) kind?: 'national' | 'school';
}
export class UpdateHolidayDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @ApiPropertyOptional({ enum: ['national', 'school'] }) @IsOptional() @IsIn(['national', 'school']) kind?: 'national' | 'school';
}
export class YearDto {
  @ApiProperty({ example: 2027 }) @IsInt() @Min(2000) @Max(2100) year!: number;
}
export class TemplateDto extends YearDto {
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() dryRun?: boolean;
}

@ApiTags('holidays')
@ApiBearerAuth()
@Controller('holidays')
export class HolidaysController {
  constructor(private ds: DataSource, private absences: AbsencesService) {}

  private async views(rows: Holiday[]) {
    const ids = [...new Set(rows.flatMap((h) => [h.createdBy, h.confirmedBy]).filter(Boolean) as string[])];
    const us = ids.length ? await this.ds.getRepository(User).find({ where: { id: In(ids) }, select: { id: true, name: true } }) : [];
    const n = new Map(us.map((x) => [x.id, x.name]));
    return rows.map((h) => ({
      id: h.id, date: h.date, name: h.name, kind: h.kind, status: h.status,
      createdBy: h.createdBy, createdByName: h.createdBy ? n.get(h.createdBy) ?? null : null, createdAt: h.createdAt,
      confirmedBy: h.confirmedBy ? { id: h.confirmedBy, name: n.get(h.confirmedBy) ?? null } : null,
      confirmedByName: h.confirmedBy ? n.get(h.confirmedBy) ?? null : null, confirmedAt: h.confirmedAt,
    }));
  }

  @Get()
  async list(@Query() q: HolidayQuery) {
    const qb = this.ds.getRepository(Holiday).createQueryBuilder('h');
    if (q.year) qb.andWhere('h.date BETWEEN :a AND :b', { a: `${q.year}-01-01`, b: `${q.year}-12-31` });
    if (q.from) qb.andWhere('h.date >= :from', { from: q.from });
    if (q.to) qb.andWhere('h.date <= :to', { to: q.to });
    if (q.status) qb.andWhere('h.status = :st', { st: q.status });
    return { items: await this.views(await qb.orderBy('h.date', 'ASC').getMany()) };
  }

  @Post() @Roles('admin')
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateHolidayDto) {
    const to = dto.to ?? dto.date;
    if (to < dto.date) throw BadRequest('Ngày kết thúc phải sau ngày bắt đầu', 'INVALID_RANGE');
    if (dayDiff(to, dto.date) + 1 > 60) throw BadRequest('Tối đa 60 ngày', 'RANGE_TOO_LONG');
    const dates = AbsencesService.range(dto.date, to);
    const { rows, cancelled } = await this.ds.transaction(async (m) => {
      const exists = await m.find(Holiday, { where: { date: In(dates) } });
      if (exists.length) throw new AppError(409, 'HOLIDAY_EXISTS', 'Ngày nghỉ đã tồn tại', { dates: exists.map((h) => h.date).sort() });
      const cancelled = await this.absences.applyHoliday(m, dates, u.id);
      const rows = await m.save(Holiday, dates.map((date) => m.create(Holiday, {
        date, name: dto.name.trim(), kind: dto.kind ?? 'school', status: 'confirmed', createdBy: u.id, confirmedBy: u.id, confirmedAt: new Date() })));
      return { rows, cancelled };
    });
    await this.absences.notifyHolidayCancellations(cancelled, dto.name.trim());
    return { items: await this.views(rows) };
  }

  private async getOr404(id: string) {
    const h = await this.ds.getRepository(Holiday).findOne({ where: { id } });
    if (!h) throw NotFound('Không tìm thấy ngày nghỉ');
    return h;
  }

  @Patch(':id') @Roles('admin')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHolidayDto) {
    const h = await this.getOr404(id);
    if (dto.name !== undefined) h.name = dto.name.trim();
    if (dto.kind !== undefined) h.kind = dto.kind;
    return (await this.views([await this.ds.getRepository(Holiday).save(h)]))[0];
  }

  @Delete(':id') @Roles('admin') @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.getOr404(id);
    await this.ds.getRepository(Holiday).delete(id);
  }

  private async confirmMany(u: AuthUser, rows: Holiday[]) {
    const pending = rows.filter((h) => h.status === 'pending');
    if (!pending.length) return rows;
    const cancelled = await this.ds.transaction(async (m) => {
      const out = [];
      for (const h of pending) {
        out.push(...(await this.absences.applyHoliday(m, [h.date], u.id)).map((c) => ({ ...c, name: h.name })));
        await m.update(Holiday, h.id, { status: 'confirmed', confirmedBy: u.id, confirmedAt: new Date() });
      }
      return out;
    });
    for (const c of cancelled) await this.absences.notifyHolidayCancellations([c], c.name);
    return this.ds.getRepository(Holiday).find({ where: { id: In(rows.map((h) => h.id)) }, order: { date: 'ASC' } });
  }

  @Post('confirm') @Roles('admin') @HttpCode(200)
  async confirmYear(@CurrentUser() u: AuthUser, @Body() dto: YearDto) {
    const rows = await this.ds.getRepository(Holiday).createQueryBuilder('h')
      .where('h.date BETWEEN :a AND :b', { a: `${dto.year}-01-01`, b: `${dto.year}-12-31` }).andWhere("h.status = 'pending'").getMany();
    return { year: dto.year, confirmed: await this.views(await this.confirmMany(u, rows)) };
  }

  @Post('template') @Roles('admin') @HttpCode(200)
  async template(@CurrentUser() u: AuthUser, @Body() dto: TemplateDto) {
    const items = nationalTemplate(dto.year);
    const existing = new Set((await this.ds.getRepository(Holiday).find({ where: { date: In(items.map((i) => i.date)) } })).map((h) => h.date));
    if (dto.dryRun) return { year: dto.year, items: items.map((i) => ({ ...i, exists: existing.has(i.date) })) };
    const todo = items.filter((i) => !existing.has(i.date));
    const { rows, cancelled } = await this.ds.transaction(async (m) => {
      const conf = todo.filter((i) => i.status === 'confirmed');
      const cancelled = [];
      for (const i of conf) cancelled.push(...(await this.absences.applyHoliday(m, [i.date], u.id)).map((c) => ({ ...c, name: i.name })));
      const rows = todo.length ? await m.save(Holiday, todo.map((i) => m.create(Holiday, {
        date: i.date, name: i.name, kind: 'national', status: i.status, createdBy: u.id,
        confirmedBy: i.status === 'confirmed' ? u.id : null, confirmedAt: i.status === 'confirmed' ? new Date() : null }))) : [];
      return { rows, cancelled };
    });
    for (const c of cancelled) await this.absences.notifyHolidayCancellations([c], c.name);
    return { year: dto.year, created: await this.views(rows), skipped: items.filter((i) => existing.has(i.date)).map(({ date, name }) => ({ date, name })) };
  }

  @Post(':id/confirm') @Roles('admin') @HttpCode(200)
  async confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const h = await this.getOr404(id);
    return (await this.views(await this.confirmMany(u, [h])))[0];
  }
}
