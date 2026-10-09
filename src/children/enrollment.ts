import { EntityManager, IsNull } from 'typeorm';
import { Child, Enrollment } from '../database/entities';

/**
 * B12 – SQL condition (alias `c` = children): the child is NOT in a gap between two stints on date `param`
 * (left before that date and re-enrolled starting after it). Children never re-enrolled are unaffected.
 */
export const notInEnrollmentGap = (param: string, alias = 'c') => `NOT EXISTS (
  SELECT 1 FROM enrollments eg WHERE eg.child_id = ${alias}.id AND eg.end_date IS NOT NULL AND eg.end_date < ${param}
    AND EXISTS (SELECT 1 FROM enrollments en WHERE en.child_id = ${alias}.id AND en.start_date > eg.end_date AND en.start_date > ${param})
    AND NOT EXISTS (SELECT 1 FROM enrollments eb WHERE eb.child_id = ${alias}.id AND eb.start_date > eg.end_date AND eb.start_date <= ${param}))`;

/** Children (of `ids`) that are in an enrollment gap on `date`. */
export async function childrenInGap(m: Pick<EntityManager, 'query'>, ids: string[], date: string): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows: { id: string }[] = await m.query(`SELECT c.id FROM children c WHERE c.id = ANY($1) AND NOT (${notInEnrollmentGap('$2::date')})`, [ids, date]);
  return new Set(rows.map((r) => r.id));
}

/** Withdrawal: close the open stint (create a closed 'initial' one if the child has none, e.g. created after the migration). */
export async function closeStint(m: EntityManager, child: Child, leave: string, reason: string, userId: string) {
  const open = await m.findOne(Enrollment, { where: { childId: child.id, endDate: IsNull() }, order: { createdAt: 'DESC' } });
  if (open) await m.update(Enrollment, open.id, { endDate: leave, endReason: reason, endedBy: userId });
  else await m.insert(Enrollment, { childId: child.id, classId: child.classId, kind: 'initial', startDate: child.enrolledAt, endDate: leave, endReason: reason, endedBy: userId });
}
