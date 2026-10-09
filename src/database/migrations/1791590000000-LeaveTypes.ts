import { MigrationInterface, QueryRunner } from 'typeorm';

/** G6–G8: leave type / half day / work days / handover note; substitution session + link to the leave. Existing leaves → personal, full day, days recomputed (Mon–Fri). */
export class LeaveTypes1791590000000 implements MigrationInterface {
  name = 'LeaveTypes1791590000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "staff_leaves" ADD COLUMN IF NOT EXISTS "type" varchar(10) NOT NULL DEFAULT 'personal'`);
    await q.query(`ALTER TABLE "staff_leaves" ADD COLUMN IF NOT EXISTS "session" varchar(10) NOT NULL DEFAULT 'full'`);
    await q.query(`ALTER TABLE "staff_leaves" ADD COLUMN IF NOT EXISTS "days" numeric(5,1) NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "staff_leaves" ADD COLUMN IF NOT EXISTS "handover_note" text`);
    await q.query(`ALTER TABLE "staff_leaves" ADD CONSTRAINT "ck_staff_leave_type" CHECK ("type" IN ('sick','annual','personal'))`);
    await q.query(`ALTER TABLE "staff_leaves" ADD CONSTRAINT "ck_staff_leave_session" CHECK ("session" IN ('full','morning','afternoon'))`);
    await q.query(`UPDATE "staff_leaves" l SET "days" = (SELECT COUNT(*) FROM generate_series(l.from_date, l.to_date, interval '1 day') g(d) WHERE EXTRACT(ISODOW FROM g.d) < 6)`);
    await q.query(`ALTER TABLE "staff_substitutions" ADD COLUMN IF NOT EXISTS "session" varchar(10) NOT NULL DEFAULT 'full'`);
    await q.query(`ALTER TABLE "staff_substitutions" ADD COLUMN IF NOT EXISTS "leave_id" uuid`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_staff_substitutions_leave" ON "staff_substitutions" ("leave_id")`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_staff_substitutions_leave"`);
    await q.query(`ALTER TABLE "staff_substitutions" DROP COLUMN IF EXISTS "leave_id", DROP COLUMN IF EXISTS "session"`);
    await q.query(`ALTER TABLE "staff_leaves" DROP CONSTRAINT IF EXISTS "ck_staff_leave_session", DROP CONSTRAINT IF EXISTS "ck_staff_leave_type"`);
    await q.query(`ALTER TABLE "staff_leaves" DROP COLUMN IF EXISTS "handover_note", DROP COLUMN IF EXISTS "days", DROP COLUMN IF EXISTS "session", DROP COLUMN IF EXISTS "type"`);
  }
}
