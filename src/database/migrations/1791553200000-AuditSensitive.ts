import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * B18: snapshot columns on audit_events so the sensitive-change history keeps a readable target / actor even after the
 * child, class or user is renamed or deleted. Additive only; existing rows are backfilled, no data removed.
 */
export class AuditSensitive1791553200000 implements MigrationInterface {
    name = 'AuditSensitive1791553200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "audit_events" ADD "actor_name" character varying(120)`);
        await queryRunner.query(`ALTER TABLE "audit_events" ADD "target_label" character varying(200)`);
        await queryRunner.query(`UPDATE audit_events e SET actor_name = u.name FROM users u WHERE u.id = e.actor_id AND e.actor_name IS NULL`);
        await queryRunner.query(`UPDATE audit_events e SET target_label = LEFT(c.full_name || COALESCE(' · ' || cl.name, ''), 200)
            FROM children c LEFT JOIN classes cl ON cl.id = c.class_id WHERE c.id = e.child_id AND e.target_label IS NULL`);
        await queryRunner.query(`UPDATE audit_events SET target_label = LEFT(before->>'childName', 200)
            WHERE target_label IS NULL AND action = 'guardian.remove' AND before ? 'childName'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "audit_events" DROP COLUMN "target_label"`);
        await queryRunner.query(`ALTER TABLE "audit_events" DROP COLUMN "actor_name"`);
    }
}
