import { DataSource } from 'typeorm';

/**
 * Simulates a parent absence report made before the cutoff for (possibly past) dates, so that a later attendance PUT
 * with status 'absent' is an excused, refundable absence (server-computed refund rule, round 2).
 */
export async function parentReported(ds: DataSource, childId: string, dates: string[], reason = 'sick') {
  const sorted = [...dates].sort();
  const [{ class_id }] = await ds.query(`SELECT class_id FROM children WHERE id = $1`, [childId]);
  const [{ id }] = await ds.query(
    `INSERT INTO absences (child_id, class_id, from_date, to_date, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [childId, class_id, sorted[0], sorted[sorted.length - 1], reason]);
  for (const d of sorted) await ds.query(`INSERT INTO absence_days (absence_id, child_id, date, refund_eligible) VALUES ($1, $2, $3, true)`, [id, childId, d]);
  return id as string;
}
