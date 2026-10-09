import { MigrationInterface, QueryRunner } from "typeorm";

export class PickupSafety1791548583600 implements MigrationInterface {
    name = 'PickupSafety1791548583600'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "authorized_pickers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "full_name" character varying(120) NOT NULL, "relation" character varying(40) NOT NULL, "photo_url" text NOT NULL, "id_number" character varying(20) NOT NULL, "phone1" character varying(20) NOT NULL, "phone2" character varying(20), "status" character varying(10) NOT NULL DEFAULT 'pending', "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "deleted_by" uuid, CONSTRAINT "PK_b183d62a473ae58c565f3ccc938" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1796224cab9d8b73317756706c" ON "authorized_pickers" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e10ae61eccaf23c62bf6c60879" ON "authorized_pickers" ("id_number") `);
        await queryRunner.query(`CREATE INDEX "IDX_f7d8b536386f92bde4f6e76f64" ON "authorized_pickers" ("phone1") `);
        await queryRunner.query(`CREATE INDEX "IDX_64710ae9d4d250a63d50588fee" ON "authorized_pickers" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_e536a6c8f752157d937c9ba5e6" ON "authorized_pickers" ("deleted_at") `);
        await queryRunner.query(`CREATE TABLE "authorized_picker_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "picker_id" uuid NOT NULL, "action" character varying(10) NOT NULL, "changes" jsonb, "changed_by" uuid, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3d2985cbe56eac34a3f6881633e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6e60d730f8cedf9940367000e5" ON "authorized_picker_history" ("picker_id") `);
        await queryRunner.query(`CREATE TABLE "sensitive_access_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid, "user_role" character varying(20) NOT NULL, "entity_type" character varying(30) NOT NULL, "entity_id" uuid NOT NULL, "child_id" uuid, "field" character varying(30) NOT NULL, "purpose" character varying(30) NOT NULL, "attendance_id" uuid, "ip" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5381270c2415a5ad7fc841bfe79" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7a7f2597cf255a751faf4da4d6" ON "sensitive_access_logs" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a17002c804bad006a3987fdbf" ON "sensitive_access_logs" ("entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c9f048ce358065ed849ad1a56c" ON "sensitive_access_logs" ("created_at") `);
        await queryRunner.query(`CREATE TABLE "pickup_duties" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" date NOT NULL, "user_id" uuid NOT NULL, "assigned_by" uuid, "note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_90e7486d06c8c5650cfdc076794" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_345b9951bbe8e2f27a137856b5" ON "pickup_duties" ("date") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_pickup_duty" ON "pickup_duties" ("date", "user_id") `);
        await queryRunner.query(`CREATE TABLE "pickup_call_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pickup_request_id" uuid NOT NULL, "called_by" uuid, "guardian_id" uuid, "phone" character varying(20) NOT NULL, "outcome" character varying(20) NOT NULL, "note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0852bbfbdf8ce0eae067e6dd2b7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c1224e7ecd7a8e62f890fc0405" ON "pickup_call_attempts" ("pickup_request_id") `);
        await queryRunner.query(`CREATE TABLE "push_subscriptions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "endpoint" text NOT NULL, "p256dh" text NOT NULL, "auth" text NOT NULL, "user_agent" character varying(300), "last_success_at" TIMESTAMP WITH TIME ZONE, "last_error" text, "fail_count" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_757fc8f00c34f66832668dc2e53" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6771f119f1c06d2ccf38f23866" ON "push_subscriptions" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0008bdfd174e533a3f98bf9af1" ON "push_subscriptions" ("endpoint") `);
        await queryRunner.query(`CREATE TABLE "notification_deliveries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel" character varying(12) NOT NULL, "user_id" uuid, "type" character varying(30) NOT NULL, "ref_id" uuid, "status" character varying(10) NOT NULL, "error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_81daeff81f237bd384f7cfc4a4c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9fcd0b72070848cc484af6bc1e" ON "notification_deliveries" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_d795ebe3bd134d87dc88709177" ON "notification_deliveries" ("ref_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ce59126b79cf703f0447f9da1a" ON "notification_deliveries" ("created_at") `);
        await queryRunner.query(`ALTER TABLE "pickups" ADD "authorized_picker_id" uuid`);
        await queryRunner.query(`ALTER TABLE "pickups" ADD "picker_kind" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "pickups" ADD "picker_phone" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "pickups" ADD "picker_id_number" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "picker_id_number" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "parent_status" character varying(10) NOT NULL DEFAULT 'pending'`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "parent_decided_by" uuid`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "parent_decided_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "parent_note" text`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "parent_channel" character varying(12)`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "school_status" character varying(10) NOT NULL DEFAULT 'pending'`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "school_decided_by" uuid`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "school_decided_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "school_note" text`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "school_decided_role" character varying(10)`);
        await queryRunner.query(`CREATE INDEX "IDX_32c200ab6ee75e046f4ed0cb1e" ON "pickups" ("picker_phone") `);
        await queryRunner.query(`CREATE INDEX "IDX_4d04ff82544c222f94a9622d71" ON "pickups" ("picker_id_number") `);
        await queryRunner.query(`ALTER TABLE "authorized_pickers" ADD CONSTRAINT "FK_1796224cab9d8b73317756706c3" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "authorized_picker_history" ADD CONSTRAINT "FK_6e60d730f8cedf9940367000e57" FOREIGN KEY ("picker_id") REFERENCES "authorized_pickers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "authorized_picker_history" ADD CONSTRAINT "FK_98cc4312f88b4ca11424bf8a6a6" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_duties" ADD CONSTRAINT "FK_09347f3558b2139d5422da71e67" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_call_attempts" ADD CONSTRAINT "FK_c1224e7ecd7a8e62f890fc04051" FOREIGN KEY ("pickup_request_id") REFERENCES "pickup_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_call_attempts" ADD CONSTRAINT "FK_206cb0f1702286f75e30fce79f1" FOREIGN KEY ("called_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "push_subscriptions" ADD CONSTRAINT "FK_6771f119f1c06d2ccf38f238664" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // legacy single-step decisions -> two-step columns (old admin decisions were "on behalf", recorded as the school step)
        await queryRunner.query(`UPDATE pickup_requests SET
            parent_status = CASE WHEN NOT decided_on_behalf AND status IN ('approved','rejected') THEN status ELSE 'pending' END,
            parent_decided_by = CASE WHEN NOT decided_on_behalf THEN decided_by END, parent_decided_at = CASE WHEN NOT decided_on_behalf THEN decided_at END,
            parent_note = CASE WHEN NOT decided_on_behalf THEN decision_note END, parent_channel = CASE WHEN NOT decided_on_behalf AND decided_by IS NOT NULL THEN 'app' END,
            school_status = CASE WHEN decided_on_behalf AND status IN ('approved','rejected') THEN status ELSE 'pending' END,
            school_decided_by = CASE WHEN decided_on_behalf THEN decided_by END, school_decided_at = CASE WHEN decided_on_behalf THEN decided_at END,
            school_note = CASE WHEN decided_on_behalf THEN decision_note END, school_decided_role = CASE WHEN decided_on_behalf THEN 'admin' END`);
        // still-open legacy 'approved' requests (one decision only, not handed over yet) go back to 'pending':
        // under the new rule they need the missing step before hand-over
        await queryRunner.query(`UPDATE pickup_requests r SET status = 'pending'
          WHERE r.status = 'approved' AND (r.parent_status <> 'approved' OR r.school_status <> 'approved')
            AND r.expires_at > now() AND NOT EXISTS (SELECT 1 FROM pickups p WHERE p.pickup_request_id = r.id)`);
        await queryRunner.query(`UPDATE pickups p SET picker_kind = CASE WHEN p.guardian_id IS NOT NULL THEN 'guardian' WHEN p.pickup_request_id IS NOT NULL THEN 'request' END,
            picker_phone = COALESCE((SELECT g.phone FROM guardians g WHERE g.id = p.guardian_id), (SELECT r.picker_phone FROM pickup_requests r WHERE r.id = p.pickup_request_id)),
            picker_id_number = (SELECT g.id_number FROM guardians g WHERE g.id = p.guardian_id)`);
        await queryRunner.query(`ALTER TABLE "authorized_pickers" ADD CONSTRAINT "ck_authorized_picker_status" CHECK (status IN ('pending','approved','rejected'))`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD CONSTRAINT "ck_pickup_request_steps" CHECK (parent_status IN ('pending','approved','rejected') AND school_status IN ('pending','approved','rejected'))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP CONSTRAINT "ck_pickup_request_steps"`);
        await queryRunner.query(`ALTER TABLE "authorized_pickers" DROP CONSTRAINT "ck_authorized_picker_status"`);
        await queryRunner.query(`ALTER TABLE "push_subscriptions" DROP CONSTRAINT "FK_6771f119f1c06d2ccf38f238664"`);
        await queryRunner.query(`ALTER TABLE "pickup_call_attempts" DROP CONSTRAINT "FK_206cb0f1702286f75e30fce79f1"`);
        await queryRunner.query(`ALTER TABLE "pickup_call_attempts" DROP CONSTRAINT "FK_c1224e7ecd7a8e62f890fc04051"`);
        await queryRunner.query(`ALTER TABLE "pickup_duties" DROP CONSTRAINT "FK_09347f3558b2139d5422da71e67"`);
        await queryRunner.query(`ALTER TABLE "authorized_picker_history" DROP CONSTRAINT "FK_98cc4312f88b4ca11424bf8a6a6"`);
        await queryRunner.query(`ALTER TABLE "authorized_picker_history" DROP CONSTRAINT "FK_6e60d730f8cedf9940367000e57"`);
        await queryRunner.query(`ALTER TABLE "authorized_pickers" DROP CONSTRAINT "FK_1796224cab9d8b73317756706c3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4d04ff82544c222f94a9622d71"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_32c200ab6ee75e046f4ed0cb1e"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "school_decided_role"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "school_note"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "school_decided_at"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "school_decided_by"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "school_status"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "parent_channel"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "parent_note"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "parent_decided_at"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "parent_decided_by"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "parent_status"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "picker_id_number"`);
        await queryRunner.query(`ALTER TABLE "pickups" DROP COLUMN "picker_id_number"`);
        await queryRunner.query(`ALTER TABLE "pickups" DROP COLUMN "picker_phone"`);
        await queryRunner.query(`ALTER TABLE "pickups" DROP COLUMN "picker_kind"`);
        await queryRunner.query(`ALTER TABLE "pickups" DROP COLUMN "authorized_picker_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ce59126b79cf703f0447f9da1a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d795ebe3bd134d87dc88709177"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9fcd0b72070848cc484af6bc1e"`);
        await queryRunner.query(`DROP TABLE "notification_deliveries"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0008bdfd174e533a3f98bf9af1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6771f119f1c06d2ccf38f23866"`);
        await queryRunner.query(`DROP TABLE "push_subscriptions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c1224e7ecd7a8e62f890fc0405"`);
        await queryRunner.query(`DROP TABLE "pickup_call_attempts"`);
        await queryRunner.query(`DROP INDEX "public"."uq_pickup_duty"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_345b9951bbe8e2f27a137856b5"`);
        await queryRunner.query(`DROP TABLE "pickup_duties"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c9f048ce358065ed849ad1a56c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9a17002c804bad006a3987fdbf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7a7f2597cf255a751faf4da4d6"`);
        await queryRunner.query(`DROP TABLE "sensitive_access_logs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6e60d730f8cedf9940367000e5"`);
        await queryRunner.query(`DROP TABLE "authorized_picker_history"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e536a6c8f752157d937c9ba5e6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_64710ae9d4d250a63d50588fee"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f7d8b536386f92bde4f6e76f64"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e10ae61eccaf23c62bf6c60879"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1796224cab9d8b73317756706c"`);
        await queryRunner.query(`DROP TABLE "authorized_pickers"`);
    }

}
