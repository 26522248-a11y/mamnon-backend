import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { AuthUser } from '../common/auth';
import { addDays, todayStr, viDayLabel } from '../common/dates';
import { AppError } from '../common/errors';
import { beforeAbsenceCutoff, kitchenNotifyRoles } from '../common/school';
import { Absence, AbsenceDay, AbsenceEvent, Attendance, AttendanceHistory, Holiday, User } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';

export const isWeekend = (d: string) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; };
export const REASON_LABEL: Record<string, string> = { sick: 'Ốm', family: 'Việc gia đình', other: 'Lý do khác' };

/** Confirmed holidays only (pending ones have no effect). */
export async function confirmedHolidays(m: EntityManager, from: string, to: string): Promise<Map<string, Holiday>> {
  const rows = await m.createQueryBuilder(Holiday, 'h').where('h.date BETWEEN :from AND :to', { from, to }).andWhere("h.status = 'confirmed'").getMany();
  return new Map(rows.map((h) => [h.date, h]));
}

/** Refund rule: reported before that day, or on that day strictly before the cutoff. */
export const refundEligibleFor = (date: string, today = todayStr(), now = new Date()) => date > today || (date === today && beforeAbsenceCutoff(now));

@Injectable()
export class AbsencesService {
  constructor(private ds: DataSource, private notify: NotificationsService) {}

  /** Dates the user may still cancel (parent: future + today before cutoff; admin: today or later). */
  cancellableDates(u: AuthUser, days: AbsenceDay[]) {
    const today = todayStr();
    return days.filter((d) => !d.cancelledAt && !d.overridden
      && (d.date > today || (d.date === today && (u.role === 'admin' || beforeAbsenceCutoff())))).map((d) => d.date);
  }

  async views(u: AuthUser, absences: Absence[]) {
    if (!absences.length) return [];
    const ids = absences.map((a) => a.id);
    const m = this.ds.manager;
    const allDays = await m.find(AbsenceDay, { where: { absenceId: In(ids) }, order: { date: 'ASC' } });
    // days on a (later) confirmed school holiday are not shown – the school was closed anyway
    const hol = allDays.length ? await confirmedHolidays(m, allDays[0].date, allDays.reduce((a, d) => (d.date > a ? d.date : a), allDays[0].date)) : new Map();
    const days = allDays.filter((d) => !hol.has(d.date));
    const events = await m.find(AbsenceEvent, { where: { absenceId: In(ids) }, order: { createdAt: 'ASC' } });
    const userIds = [...new Set([...absences.map((a) => a.createdBy), ...events.map((e) => e.actorId)].filter(Boolean) as string[])];
    const users = userIds.length ? await m.find(User, { where: { id: In(userIds) }, select: { id: true, name: true, role: true } }) : [];
    const uname = new Map(users.map((x) => [x.id, x]));
    const meta: any[] = await m.query(
      `SELECT c.id, c.full_name, c.class_id, cl.name AS class_name FROM children c LEFT JOIN classes cl ON cl.id = c.class_id WHERE c.id = ANY($1)`,
      [[...new Set(absences.map((a) => a.childId))]]);
    const cm = new Map(meta.map((r) => [r.id, r]));
    return absences.map((a) => {
      const ds = days.filter((d) => d.absenceId === a.id);
      const all = allDays.filter((d) => d.absenceId === a.id);
      const active = all.filter((d) => !d.cancelledAt);
      const status = !active.length ? 'cancelled' : active.length < all.length ? 'partly_cancelled' : 'active';
      const c = cm.get(a.childId);
      const skipped = (a as any).skippedDates;
      return {
        id: a.id, childId: a.childId, childName: c?.full_name ?? null, classId: a.classId ?? c?.class_id ?? null, className: c?.class_name ?? null,
        from: a.from, to: a.to, reason: a.reason, note: a.note,
        days: ds.map((d) => ({ date: d.date, refundEligible: d.refundEligible && !d.overridden && !d.cancelledAt, reportedAt: a.createdAt,
          overridden: d.overridden, cancelled: !!d.cancelledAt, cancelledAt: d.cancelledAt })),
        ...(skipped ? { skippedDates: skipped } : {}),
        status, cancellable: u.role === 'parent' || u.role === 'admin' ? this.cancellableDates(u, ds) : [],
        createdAt: a.createdAt, createdBy: a.createdBy, createdByName: a.createdBy ? uname.get(a.createdBy)?.name ?? null : null,
        cancelledAt: a.cancelledAt,
        history: events.filter((e) => e.absenceId === a.id).map((e) => ({
          action: e.action, dates: e.dates, by: e.actorId, byName: e.actorId ? uname.get(e.actorId)?.name ?? null : null,
          byRole: e.actorId ? uname.get(e.actorId)?.role ?? null : null, at: e.createdAt,
        })),
      };
    });
  }

  async classTeacherIds(classId: string | null, m?: EntityManager): Promise<string[]> {
    if (!classId) return [];
    const r = await (m ?? this.ds.manager).query(
      `SELECT ct.user_id FROM class_teachers ct JOIN users u ON u.id = ct.user_id WHERE ct.class_id = $1 AND u.is_active`, [classId]);
    return r.map((x: any) => x.user_id);
  }
  async kitchenIds(m?: EntityManager): Promise<string[]> {
    const roles = kitchenNotifyRoles();
    if (!roles.length) return [];
    const r = await (m ?? this.ds.manager).query(`SELECT id FROM users WHERE is_active AND role = ANY($1)`, [roles]);
    return r.map((x: any) => x.id);
  }

  /**
   * Cancel the given active days of one absence inside `m`: marks days cancelled, removes the attendance rows that were
   * generated from the report, closes the report when no active day is left, writes the 'cancelled' event.
   */
  async cancelDays(m: EntityManager, absence: Absence, dates: string[], actorId: string | null) {
    if (!dates.length) return;
    const now = new Date();
    await m.createQueryBuilder().update(AbsenceDay).set({ cancelledAt: now, cancelledBy: actorId })
      .where('absence_id = :id AND date IN (:...dates) AND cancelled_at IS NULL', { id: absence.id, dates }).execute();
    await m.createQueryBuilder().delete().from(Attendance)
      .where("absence_id = :id AND date IN (:...dates) AND status = 'absent'", { id: absence.id, dates }).execute();
    const left = await m.count(AbsenceDay, { where: { absenceId: absence.id, cancelledAt: IsNull() } });
    if (!left) await m.update(Absence, absence.id, { cancelledAt: now });
    await m.save(AbsenceEvent, m.create(AbsenceEvent, { absenceId: absence.id, action: 'cancelled', dates, actorId }));
  }

  /**
   * Holiday becomes effective on `dates`: refuse if attendance was recorded there (other than from parent reports),
   * cancel active absence days on those dates. Returns affected absences (for notifications after commit).
   */
  async applyHoliday(m: EntityManager, dates: string[], actorId: string) {
    if (!dates.length) return [] as { absence: Absence; dates: string[] }[];
    const [{ n }] = await m.query(`SELECT COUNT(*)::int AS n FROM attendance WHERE date = ANY($1) AND absence_id IS NULL`, [dates]);
    if (n > 0) {
      const rows = await m.query(`SELECT DISTINCT date::text AS d FROM attendance WHERE date = ANY($1) AND absence_id IS NULL ORDER BY 1`, [dates]);
      throw new AppError(409, 'HOLIDAY_HAS_ATTENDANCE', 'Đã có điểm danh trong ngày này, không thể đặt làm ngày nghỉ', { dates: rows.map((r: any) => r.d), count: n });
    }
    const days = await m.createQueryBuilder(AbsenceDay, 'd').where('d.date IN (:...dates)', { dates }).andWhere('d.cancelled_at IS NULL').getMany();
    const byAbs = new Map<string, string[]>();
    for (const d of days) byAbs.set(d.absenceId, [...(byAbs.get(d.absenceId) ?? []), d.date]);
    const out: { absence: Absence; dates: string[] }[] = [];
    for (const [id, ds] of byAbs) {
      const a = await m.findOneByOrFail(Absence, { id });
      await this.cancelDays(m, a, ds, actorId);
      out.push({ absence: a, dates: ds });
    }
    return out;
  }

  async notifyHolidayCancellations(items: { absence: Absence; dates: string[] }[], holidayName: string) {
    for (const { absence, dates } of items) {
      const parents = await this.notify.parentIdsOfChildren([absence.childId]);
      await this.notify.send(parents, {
        type: 'absence_cancelled', title: `Trường nghỉ ${holidayName}: báo vắng ngày ${dates.join(', ')} không còn cần thiết`,
        data: { absenceId: absence.id, childId: absence.childId, dates, reason: 'HOLIDAY' }, refId: absence.id,
      });
    }
  }

  /** Teacher explicitly marks present on an excused day: day overridden (no refund), kitchen + parents notified (after commit). */
  async override(m: EntityManager, day: AbsenceDay, actorId: string) {
    await m.update(AbsenceDay, day.id, { overridden: true, overriddenBy: actorId, overriddenAt: new Date() });
    await m.save(AbsenceEvent, m.create(AbsenceEvent, { absenceId: day.absenceId, action: 'overridden', dates: [day.date], actorId }));
  }
  async notifyOverride(childId: string, childName: string, className: string | null, date: string, absenceId: string, teacherName: string) {
    const msg = {
      title: `${childName}${className ? ` (${className})` : ''} có mặt ${viDayLabel(date)} dù đã báo vắng`,
      body: `${teacherName} điểm danh có mặt – không hoàn tiền ăn ngày này, bếp tính thêm 1 suất.`,
      data: { childId, date, absenceId }, refId: absenceId,
    };
    await this.notify.send(await this.kitchenIds(), { type: 'kitchen_change', ...msg });
    await this.notify.send(await this.notify.parentIdsOfChildren([childId]), { type: 'absence_overridden', ...msg,
      body: `${teacherName} đã điểm danh bé có mặt; ngày này không được hoàn tiền ăn.` });
  }

  /** Dates between from..to inclusive. */
  static range(from: string, to: string) {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
}
