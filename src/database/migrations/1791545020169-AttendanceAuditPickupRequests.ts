import { MigrationInterface, QueryRunner } from "typeorm";

export class AttendanceAuditPickupRequests1791545020169 implements MigrationInterface {
    name = 'AttendanceAuditPickupRequests1791545020169'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "attendance_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "attendance_id" uuid NOT NULL, "action" character varying(10) NOT NULL, "old_status" character varying(10), "old_note" text, "new_status" character varying(10) NOT NULL, "new_note" text, "changed_by" uuid, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_bf5833b3978873cb01e6258fd4a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1e776d10894d5e91704034eef2" ON "attendance_history" ("attendance_id") `);
        await queryRunner.query(`CREATE TABLE "pickup_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "attendance_id" uuid NOT NULL, "child_id" uuid NOT NULL, "class_id" uuid NOT NULL, "picker_name" character varying(120) NOT NULL, "picker_phone" character varying(20) NOT NULL, "relation" character varying(40), "note" text, "photo_url" text, "status" character varying(10) NOT NULL DEFAULT 'pending', "requested_by" uuid, "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_4a347837d7b9ff0c32e41951a6a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c5466a03eb2b627ed466686dcb" ON "pickup_requests" ("attendance_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_1b7d57ed623086f5c539d47b72" ON "pickup_requests" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_bf7e791fc7df3902c75229f491" ON "pickup_requests" ("class_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ed8344a391afb7463ffcf07d65" ON "pickup_requests" ("status") `);
        await queryRunner.query(`ALTER TABLE "pickups" ADD "pickup_request_id" uuid`);
        await queryRunner.query(`ALTER TABLE "attendance_history" ADD CONSTRAINT "FK_1e776d10894d5e91704034eef2e" FOREIGN KEY ("attendance_id") REFERENCES "attendance"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "attendance_history" ADD CONSTRAINT "FK_3d73d36eb641a71521909cdbd28" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD CONSTRAINT "FK_c5466a03eb2b627ed466686dcbd" FOREIGN KEY ("attendance_id") REFERENCES "attendance"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD CONSTRAINT "FK_1b7d57ed623086f5c539d47b722" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD CONSTRAINT "FK_a998bbfeb7da594deecdc7f0a63" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP CONSTRAINT "FK_a998bbfeb7da594deecdc7f0a63"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP CONSTRAINT "FK_1b7d57ed623086f5c539d47b722"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP CONSTRAINT "FK_c5466a03eb2b627ed466686dcbd"`);
        await queryRunner.query(`ALTER TABLE "attendance_history" DROP CONSTRAINT "FK_3d73d36eb641a71521909cdbd28"`);
        await queryRunner.query(`ALTER TABLE "attendance_history" DROP CONSTRAINT "FK_1e776d10894d5e91704034eef2e"`);
        await queryRunner.query(`ALTER TABLE "pickups" DROP COLUMN "pickup_request_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ed8344a391afb7463ffcf07d65"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bf7e791fc7df3902c75229f491"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1b7d57ed623086f5c539d47b72"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c5466a03eb2b627ed466686dcb"`);
        await queryRunner.query(`DROP TABLE "pickup_requests"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1e776d10894d5e91704034eef2"`);
        await queryRunner.query(`DROP TABLE "attendance_history"`);
    }

}
