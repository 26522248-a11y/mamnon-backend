import { MigrationInterface, QueryRunner } from "typeorm";

export class AuditEvents1791549588287 implements MigrationInterface {
    name = 'AuditEvents1791549588287'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "audit_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actor_id" uuid, "actor_username" character varying(60), "actor_role" character varying(20), "action" character varying(60) NOT NULL, "entity_type" character varying(40) NOT NULL, "entity_id" character varying(64), "child_id" uuid, "before" jsonb, "after" jsonb, "reason" text, "ip" character varying(64), "data" jsonb, "source" character varying(30) NOT NULL DEFAULT 'api', "dedupe_key" character varying(80), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_910f64d901a5c3e9878f0d4a407" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_audit_events_dedupe" ON "audit_events" ("dedupe_key") `);
        await queryRunner.query(`CREATE INDEX "IDX_497bb4f7c4c55db9749616cd2a" ON "audit_events" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "ix_audit_events_actor_created" ON "audit_events" ("actor_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "ix_audit_events_action_created" ON "audit_events" ("action", "created_at") `);
        await queryRunner.query(`CREATE INDEX "ix_audit_events_child_created" ON "audit_events" ("child_id", "created_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."ix_audit_events_child_created"`);
        await queryRunner.query(`DROP INDEX "public"."ix_audit_events_action_created"`);
        await queryRunner.query(`DROP INDEX "public"."ix_audit_events_actor_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_497bb4f7c4c55db9749616cd2a"`);
        await queryRunner.query(`DROP INDEX "public"."uq_audit_events_dedupe"`);
        await queryRunner.query(`DROP TABLE "audit_events"`);
    }

}
