import { MigrationInterface, QueryRunner } from "typeorm";

/** B12: enrollment stints (re-enrollment of withdrawn children). Backfills one 'initial' stint per existing child; deletes nothing. */
export class Enrollments1791553300000 implements MigrationInterface {
    name = 'Enrollments1791553300000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "enrollments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "class_id" uuid, "kind" character varying(12) NOT NULL DEFAULT 'initial', "start_date" date, "end_date" date, "end_reason" text, "note" text, "started_by" uuid, "ended_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_enrollments" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_enrollments_child_start" ON "enrollments" ("child_id", "start_date") `);
        await queryRunner.query(`ALTER TABLE "enrollments" ADD CONSTRAINT "FK_enrollments_child" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "enrollments" ADD CONSTRAINT "FK_enrollments_class" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`INSERT INTO enrollments (child_id, class_id, kind, start_date, end_date, end_reason, ended_by, created_at)
            SELECT id, class_id, 'initial', enrolled_at, CASE WHEN status = 'withdrawn' THEN leave_date END,
                   CASE WHEN status = 'withdrawn' THEN withdrawal_reason END, CASE WHEN status = 'withdrawn' THEN withdrawn_by END, created_at
            FROM children`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "enrollments"`);
    }
}
