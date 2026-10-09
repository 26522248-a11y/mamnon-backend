import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { In, Repository } from 'typeorm';
import { AccessService } from '../common/access';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { BadRequest, Forbidden, NotFound } from '../common/errors';
import { Child, ClassRoom, ClassTeacher, User } from '../database/entities';

export class CreateClassDto {
  @ApiProperty({ example: 'Mầm 1' }) @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @ApiProperty({ example: '3-4 tuổi' }) @IsString() @MaxLength(40) ageGroup!: string;
  @ApiPropertyOptional({ example: '2026-2027' }) @IsOptional() @IsString() @MaxLength(20) schoolYear?: string;
  @ApiPropertyOptional({ example: 'P101' }) @IsOptional() @IsString() @MaxLength(40) room?: string;
  @ApiPropertyOptional({ example: 30 }) @IsOptional() @IsInt() @Min(1) capacity?: number;
}
export class UpdateClassDto extends PartialType(CreateClassDto) {}
export class AssignTeacherDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() isHead?: boolean;
}

@ApiTags('classes') @ApiBearerAuth()
@Controller('classes')
export class ClassesController {
  constructor(
    @InjectRepository(ClassRoom) private classes: Repository<ClassRoom>,
    @InjectRepository(ClassTeacher) private ct: Repository<ClassTeacher>,
    @InjectRepository(Child) private children: Repository<Child>,
    @InjectRepository(User) private users: Repository<User>,
    private access: AccessService,
  ) {}

  private async view(list: ClassRoom[]) {
    if (!list.length) return [];
    const ids = list.map((c) => c.id);
    const counts: { class_id: string; n: string }[] = await this.children.createQueryBuilder('c')
      .select('c.class_id', 'class_id').addSelect('COUNT(*)', 'n')
      .where('c.class_id IN (:...ids)', { ids }).andWhere("c.status = 'active'").groupBy('c.class_id').getRawMany();
    const teachers = await this.ct.find({ where: { classId: In(ids) }, relations: { user: true } });
    return list.map((c) => ({
      id: c.id, name: c.name, ageGroup: c.ageGroup, schoolYear: c.schoolYear, room: c.room, capacity: c.capacity,
      childCount: Number(counts.find((x) => x.class_id === c.id)?.n ?? 0),
      teachers: teachers.filter((t) => t.classId === c.id).map((t) => ({ id: t.userId, name: t.user.name, isHead: t.isHead })),
    }));
  }

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    let where: any = {};
    if (u.role === 'teacher') where = { id: In(u.classIds.length ? u.classIds : ['00000000-0000-0000-0000-000000000000']) };
    if (u.role === 'parent') {
      const kids = u.childIds.length ? await this.children.find({ where: { id: In(u.childIds) } }) : [];
      const ids = kids.map((k) => k.classId).filter(Boolean) as string[];
      where = { id: In(ids.length ? ids : ['00000000-0000-0000-0000-000000000000']) };
    }
    return this.view(await this.classes.find({ where, order: { name: 'ASC' } }));
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.access.getClassOr404(id);
    let ok = this.access.canReadClass(u, id);
    if (u.role === 'parent') ok = (await this.children.count({ where: { id: In(u.childIds.length ? u.childIds : [id]), classId: id } })) > 0 && u.childIds.length > 0;
    if (!ok) throw Forbidden('Không có quyền với lớp này');
    return (await this.view([c]))[0];
  }

  @Post() @Roles('admin')
  async create(@Body() dto: CreateClassDto) {
    const c = await this.classes.save(this.classes.create(dto));
    return (await this.view([c]))[0];
  }

  @Patch(':id') @Roles('admin')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClassDto) {
    const c = await this.access.getClassOr404(id);
    Object.assign(c, dto);
    await this.classes.save(c);
    return (await this.view([c]))[0];
  }

  @Delete(':id') @Roles('admin') @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.access.getClassOr404(id);
    if (await this.children.count({ where: { classId: id, status: 'active' } }))
      throw BadRequest('Lớp còn trẻ đang học, hãy chuyển trẻ sang lớp khác trước khi xoá', 'CLASS_NOT_EMPTY');
    await this.classes.delete(id);
  }

  @Post(':id/teachers') @Roles('admin')
  async assignTeacher(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTeacherDto) {
    await this.access.getClassOr404(id);
    const t = await this.users.findOne({ where: { id: dto.userId } });
    if (!t) throw NotFound('Không tìm thấy giáo viên');
    if (t.role !== 'teacher') throw BadRequest('Tài khoản này không phải giáo viên', 'NOT_A_TEACHER');
    await this.ct.save({ classId: id, userId: dto.userId, isHead: dto.isHead ?? false });
    return (await this.view([await this.access.getClassOr404(id)]))[0];
  }

  @Delete(':id/teachers/:userId') @Roles('admin') @HttpCode(204)
  async unassignTeacher(@Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    const r = await this.ct.delete({ classId: id, userId });
    if (!r.affected) throw NotFound('Giáo viên không thuộc lớp này');
  }
}
