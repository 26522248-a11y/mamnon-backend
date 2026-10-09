import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Between, DataSource, In, Repository } from 'typeorm';
import { assertDateEditable } from '../attendance/attendance.controller';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { addDays, dayDiff, todayStr } from '../common/dates';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { Child, DailyNote, EatingLevel, GrowthRecord, Meal, MenuItem } from '../database/entities';

const MEALS: Meal[] = ['breakfast', 'lunch', 'snack'];
const EATING: EatingLevel[] = ['all', 'most', 'half', 'little', 'none'];

export class GrowthDto {
  @ApiProperty({ example: '2026-10-01' }) @IsDateString() date!: string;
  @ApiPropertyOptional({ example: 98.5 }) @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(40) @Max(150) heightCm?: number;
  @ApiPropertyOptional({ example: 15.2 }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(2) @Max(60) weightKg?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class RangeQuery {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' }) @IsOptional() @IsDateString() to?: string;
}
export class WeekQuery {
  @ApiPropertyOptional({ example: '2026-10-09', description: 'Ngày bất kỳ trong tuần; mặc định tuần này' }) @IsOptional() @IsDateString() week?: string;
}
class MenuEntryDto {
  @ApiProperty({ example: '2026-10-05' }) @IsDateString() date!: string;
  @ApiProperty({ enum: MEALS }) @IsIn(MEALS) meal!: Meal;
  @ApiProperty({ example: 'Cháo tôm, sữa' }) @IsString() @MaxLength(500) dishes!: string;
  @ApiPropertyOptional({ example: 'Dị ứng hải sản: thay tôm bằng thịt gà', description: 'Ghi chú món thay thế cho trẻ dị ứng' })
  @IsOptional() @IsString() @MaxLength(1000) allergyNotes?: string;
}
export class PutMenuDto {
  @ApiProperty({ example: '2026-10-05', description: 'Thứ Hai đầu tuần' }) @IsDateString() weekStart!: string;
  @ApiProperty({ type: [MenuEntryDto], description: 'dishes rỗng = xoá món của bữa đó' })
  @IsArray() @ArrayMaxSize(21) @ValidateNested({ each: true }) @Type(() => MenuEntryDto) items!: MenuEntryDto[];
}
export class DateQuery {
  @ApiPropertyOptional({ example: '2026-10-09' }) @IsOptional() @IsDateString() date?: string;
}
class DailyNoteItemDto {
  @ApiProperty() @IsUUID() childId!: string;
  @ApiPropertyOptional({ enum: EATING }) @IsOptional() @IsIn(EATING) eating?: EatingLevel;
  @ApiPropertyOptional({ example: 120, description: 'Phút ngủ trưa' }) @IsOptional() @IsInt() @Min(0) @Max(300) sleepMinutes?: number;
  @ApiPropertyOptional({ example: 'Vui vẻ' }) @IsOptional() @IsString() @MaxLength(40) mood?: string;
  @ApiPropertyOptional({ example: 'Bình thường' }) @IsOptional() @IsString() @MaxLength(40) toilet?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class PutDailyNotesDto {
  @ApiProperty({ example: '2026-10-09' }) @IsDateString() date!: string;
  @ApiProperty({ type: [DailyNoteItemDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DailyNoteItemDto) items!: DailyNoteItemDto[];
}

/** Monday of the week containing d (YYYY-MM-DD). */
function mondayOf(d: string) {
  const dow = new Date(d + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}
const growthView = (g: GrowthRecord) => ({
  id: g.id, childId: g.childId, date: g.date, heightCm: g.heightCm, weightKg: g.weightKg, note: g.note,
  bmi: g.heightCm && g.weightKg ? Math.round((g.weightKg / (g.heightCm / 100) ** 2) * 10) / 10 : null,
});
/** [dto/entity field, column] that a daily-note item may set */
const NOTE_FIELDS: [keyof DailyNote, string][] = [['eating', 'eating'], ['sleepMinutes', 'sleep_minutes'], ['mood', 'mood'], ['toilet', 'toilet'], ['note', 'note']];
const noteView = (n: DailyNote) => ({
  id: n.id, childId: n.childId, classId: n.classId, date: n.date, eating: n.eating, sleepMinutes: n.sleepMinutes, mood: n.mood,
  toilet: n.toilet, note: n.note, updatedAt: n.updatedAt,
});

/**
 * Health & nutrition.
 *  - growth & daily notes: admin all; teacher writes/reads own classes; parent reads own child; accountant 403.
 *  - weekly menu: admin writes; teacher & parent read; accountant 403.
 */
@ApiTags('health') @ApiBearerAuth()
@Controller()
export class HealthController {
  constructor(
    @InjectRepository(GrowthRecord) private growth: Repository<GrowthRecord>,
    @InjectRepository(MenuItem) private menus: Repository<MenuItem>,
    @InjectRepository(DailyNote) private notes: Repository<DailyNote>,
    @InjectRepository(Child) private children: Repository<Child>,
    private access: AccessService, private ds: DataSource,
  ) {}

  private async childForWrite(u: AuthUser, id: string) {
    const c = await this.access.getChildOr404(id);
    if (!this.access.canOperateClass(u, c.classId)) throw Forbidden('Không có quyền với trẻ này');
    return c;
  }

  // ───── growth ─────
  @Get('children/:id/growth') @Roles('admin', 'teacher', 'parent')
  async listGrowth(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertChildRead(u, id, true);
    return (await this.growth.find({ where: { childId: id }, order: { date: 'ASC' } })).map(growthView);
  }

  /** Upsert by (child, date). */
  @Post('children/:id/growth') @Roles('admin', 'teacher')
  async addGrowth(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GrowthDto) {
    await this.childForWrite(u, id);
    if (dayDiff(todayStr(), dto.date) < 0) throw BadRequest('Không thể ghi cho ngày trong tương lai', 'DATE_IN_FUTURE');
    if (dto.heightCm === undefined && dto.weightKg === undefined) throw BadRequest('Cần ít nhất chiều cao hoặc cân nặng');
    const existing = await this.growth.findOne({ where: { childId: id, date: dto.date } });
    const g = await this.growth.save({ ...(existing ?? {}), childId: id, date: dto.date, heightCm: dto.heightCm ?? existing?.heightCm ?? null,
      weightKg: dto.weightKg ?? existing?.weightKg ?? null, note: dto.note ?? existing?.note ?? null, recordedBy: u.id });
    return growthView((await this.growth.findOne({ where: { id: g.id } }))!);
  }

  @Delete('growth/:id') @Roles('admin', 'teacher') @HttpCode(204)
  async removeGrowth(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const g = await this.growth.findOne({ where: { id } });
    if (!g) throw NotFound('Không tìm thấy bản ghi');
    await this.childForWrite(u, g.childId);
    await this.growth.delete(id);
  }

  // ───── weekly menu (school-wide) ─────
  @Get('menus') @Roles('admin', 'teacher', 'parent')
  async getMenu(@CurrentUser() u: AuthUser, @Query() q: WeekQuery) {
    const weekStart = mondayOf(q.week ?? todayStr()), weekEnd = addDays(weekStart, 6);
    const rows = await this.menus.find({ where: { date: Between(weekStart, weekEnd) } });
    const find = (date: string, m: Meal) => rows.find((r) => r.date === date && r.meal === m);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((date) => ({
      date,
      meals: Object.fromEntries(MEALS.map((m) => [m, find(date, m)?.dishes ?? null])),
      allergyNotes: Object.fromEntries(MEALS.map((m) => [m, find(date, m)?.allergyNotes ?? null])),
    }));
    // children with allergies the viewer is responsible for (admin: all, teacher: own classes, parent: own children)
    const qb = this.children.createQueryBuilder('c').leftJoinAndSelect('c.classRoom', 'cl')
      .where("c.status = 'active'").andWhere("COALESCE(TRIM(c.allergies), '') <> ''");
    if (u.role === 'teacher') qb.andWhere('c.class_id = ANY(:cids)', { cids: u.classIds });
    if (u.role === 'parent') qb.andWhere('c.id = ANY(:kids)', { kids: u.childIds });
    const allergyAlerts = (await qb.orderBy('cl.name').addOrderBy('c.fullName').getMany())
      .map((c) => ({ childId: c.id, fullName: c.fullName, className: c.classRoom?.name ?? null, allergies: c.allergies }));
    return { weekStart, weekEnd, days, allergyAlerts };
  }

  @Put('menus') @Roles('admin')
  async putMenu(@CurrentUser() u: AuthUser, @Body() dto: PutMenuDto) {
    if (mondayOf(dto.weekStart) !== dto.weekStart) throw BadRequest('weekStart phải là thứ Hai', 'INVALID_WEEK_START');
    const end = addDays(dto.weekStart, 6);
    if (dto.items.some((i) => i.date < dto.weekStart || i.date > end)) throw BadRequest('Có ngày nằm ngoài tuần', 'DATE_OUT_OF_WEEK');
    await this.ds.transaction(async (m) => {
      for (const i of dto.items) {
        if (!i.dishes.trim()) { await m.delete(MenuItem, { date: i.date, meal: i.meal }); continue; }
        await m.createQueryBuilder().insert().into(MenuItem)
          .values({ date: i.date, meal: i.meal, dishes: i.dishes.trim(), allergyNotes: i.allergyNotes?.trim() || null, updatedBy: u.id })
          .orUpdate(['dishes', 'allergy_notes', 'updated_by', 'updated_at'], ['date', 'meal']).execute();
      }
    });
    return this.getMenu(u, { week: dto.weekStart });
  }

  // ───── daily notes (eating / sleeping) ─────
  @Get('classes/:id/daily-notes') @Roles('admin', 'teacher')
  async classNotes(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: DateQuery) {
    await this.access.getClassOr404(id);
    this.access.assertOperateClass(u, id);
    const date = q.date ?? todayStr();
    const kids = await this.children.find({ where: { classId: id, status: 'active' }, order: { fullName: 'ASC' } });
    const rows = await this.notes.find({ where: { classId: id, date } });
    return {
      classId: id, date,
      items: kids.map((k) => {
        const n = rows.find((r) => r.childId === k.id);
        return { fullName: k.fullName, recorded: !!n, ...(n ? noteView(n) : { childId: k.id, id: null, eating: null, sleepMinutes: null, mood: null, toilet: null, note: null }) };
      }),
    };
  }

  /**
   * Bulk upsert (PUT or PATCH, same behaviour); same edit window as attendance (teacher: today .. 3 days back).
   * PARTIAL per item: only fields present in the item are written; absent = unchanged, explicit null = clear.
   * So two teachers can record different fields of the same child without overwriting each other.
   */
  @Put('classes/:id/daily-notes') @Roles('admin', 'teacher')
  putNotesRoute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutDailyNotesDto) { return this.putNotes(u, id, dto); }

  @Patch('classes/:id/daily-notes') @Roles('admin', 'teacher')
  patchNotes(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutDailyNotesDto) { return this.putNotes(u, id, dto); }

  private async putNotes(u: AuthUser, id: string, dto: PutDailyNotesDto) {
    await this.access.getClassOr404(id);
    this.access.assertOperateClass(u, id);
    assertDateEditable(u, dto.date);
    const ids = dto.items.map((i) => i.childId);
    if (new Set(ids).size !== ids.length) throw BadRequest('Trùng trẻ trong danh sách');
    if (ids.length) {
      const kids = await this.children.find({ where: { id: In(ids) } });
      const bad = ids.filter((cid) => kids.find((k) => k.id === cid)?.classId !== id);
      if (bad.length) throw BadRequest(`Trẻ không thuộc lớp này: ${bad.join(', ')}`, 'CHILD_NOT_IN_CLASS');
    }
    await this.ds.transaction(async (m) => {
      for (const i of dto.items) {
        const present = NOTE_FIELDS.filter(([f]) => (i as any)[f] !== undefined);
        const values: any = { childId: i.childId, classId: id, date: dto.date, recordedBy: u.id };
        for (const [f] of present) values[f] = (i as any)[f]; // null = clear
        await m.createQueryBuilder().insert().into(DailyNote).values(values)
          .orUpdate([...present.map(([, col]) => col), 'recorded_by', 'class_id', 'updated_at'], ['child_id', 'date']).execute();
      }
    });
    return this.classNotes(u, id, { date: dto.date });
  }

  @Get('children/:id/daily-notes') @Roles('admin', 'teacher', 'parent')
  async childNotes(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: RangeQuery) {
    await this.access.assertChildRead(u, id, true);
    const to = q.to ?? todayStr(), from = q.from ?? addDays(to, -30);
    return (await this.notes.find({ where: { childId: id, date: Between(from, to) }, order: { date: 'DESC' } })).map(noteView);
  }
}
