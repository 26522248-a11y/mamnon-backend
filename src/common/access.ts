import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Child, ClassRoom } from '../database/entities';
import { AuthUser } from './auth';
import { Forbidden, NotFound } from './errors';

/**
 * Central row-level authorization rules.
 *  - admin: everything
 *  - teacher: only classes in class_teachers (and children in those classes)
 *  - accountant: read-only basic info for all classes/children (name, class) — no health/attendance detail
 *  - parent: only children linked via guardians.user_id
 */
@Injectable()
export class AccessService {
  constructor(
    @InjectRepository(ClassRoom) private classes: Repository<ClassRoom>,
    @InjectRepository(Child) private children: Repository<Child>,
  ) {}

  async getClassOr404(id: string) {
    const c = await this.classes.findOne({ where: { id } });
    if (!c) throw NotFound('Không tìm thấy lớp');
    return c;
  }
  async getChildOr404(id: string) {
    const c = await this.children.findOne({ where: { id }, relations: { classRoom: true } });
    if (!c) throw NotFound('Không tìm thấy trẻ');
    return c;
  }

  canReadClass(u: AuthUser, classId: string) {
    return u.role === 'admin' || u.role === 'accountant' || (u.role === 'teacher' && u.classIds.includes(classId));
  }
  /** Attendance/health level access to a class: admin + teacher of class. */
  canOperateClass(u: AuthUser, classId: string | null) {
    return u.role === 'admin' || (u.role === 'teacher' && !!classId && u.classIds.includes(classId));
  }
  assertOperateClass(u: AuthUser, classId: string) {
    if (!this.canOperateClass(u, classId)) throw Forbidden('Không có quyền với lớp này');
  }
  canReadChild(u: AuthUser, child: Child) {
    if (u.role === 'admin' || u.role === 'accountant') return true;
    if (u.role === 'teacher') return !!child.classId && u.classIds.includes(child.classId);
    return u.childIds.includes(child.id);
  }
  /** Full detail (health, guardians, attendance): admin, teacher of class, parent of child. */
  canReadChildDetail(u: AuthUser, child: Child) {
    return u.role !== 'accountant' && this.canReadChild(u, child);
  }
  async assertChildRead(u: AuthUser, id: string, detail = false) {
    const c = await this.getChildOr404(id);
    if (!(detail ? this.canReadChildDetail(u, c) : this.canReadChild(u, c))) throw Forbidden('Không có quyền xem trẻ này');
    return c;
  }
}
