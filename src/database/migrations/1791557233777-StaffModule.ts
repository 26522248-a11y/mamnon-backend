import { MigrationInterface, QueryRunner } from "typeorm";

export class StaffModule1791557233777 implements MigrationInterface {
    name = 'StaffModule1791557233777'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "staff_shifts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(60) NOT NULL, "start_time" character varying(5) NOT NULL, "end_time" character varying(5) NOT NULL, "late_grace_minutes" integer NOT NULL DEFAULT '5', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7861d1bb0a4252ed8d3f5107656" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "staff_shift_assignments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" date NOT NULL, "user_id" uuid NOT NULL, "shift_id" uuid NOT NULL, "class_id" uuid, "note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_f986b24dc4eb76d6fbd8fa414ec" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_89e217c19b7600aa5fcfc5c566" ON "staff_shift_assignments" ("date") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b2aecfaff5d4619856580aac0" ON "staff_shift_assignments" ("user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_staff_assignment" ON "staff_shift_assignments" ("user_id", "date", "shift_id") `);
        await queryRunner.query(`CREATE TABLE "staff_checkins" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" date NOT NULL, "user_id" uuid NOT NULL, "check_in_at" TIMESTAMP WITH TIME ZONE, "check_out_at" TIMESTAMP WITH TIME ZONE, "check_in_ip" character varying(64), "check_out_ip" character varying(64), "source" character varying(10) NOT NULL DEFAULT 'self', "note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cb0f84c79e19cc4944b61fd6a2d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b7e4a526f108d1e3015522f2ca" ON "staff_checkins" ("date") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_staff_checkin_day" ON "staff_checkins" ("user_id", "date") `);
        await queryRunner.query(`CREATE TABLE "staff_leaves" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "from_date" date NOT NULL, "to_date" date NOT NULL, "reason" text NOT NULL, "status" character varying(12) NOT NULL DEFAULT 'pending', "requested_by" uuid, "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1b6ce70ebb4dfffa0568df2f824" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2892880548c5c37d84f6c0457e" ON "staff_leaves" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f0e15d193780815afd1bff811f" ON "staff_leaves" ("status") `);
        await queryRunner.query(`CREATE TABLE "staff_substitutions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" date NOT NULL, "shift_id" uuid NOT NULL, "class_id" uuid NOT NULL, "absent_user_id" uuid, "substitute_user_id" uuid NOT NULL, "reason" text, "note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0675cfc8378cde39c73ab3646dd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5227431f29f8e5946a9f2f3d7d" ON "staff_substitutions" ("date") `);
        await queryRunner.query(`CREATE INDEX "IDX_d6cb48149a132ffc6d05f07867" ON "staff_substitutions" ("substitute_user_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_substitution_slot" ON "staff_substitutions" ("date", "shift_id", "class_id") `);
        await queryRunner.query(`ALTER TABLE "staff_shift_assignments" ADD CONSTRAINT "FK_9b2aecfaff5d4619856580aac01" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_shift_assignments" ADD CONSTRAINT "FK_f5133e84764accab00ba01e2b6d" FOREIGN KEY ("shift_id") REFERENCES "staff_shifts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_shift_assignments" ADD CONSTRAINT "FK_f00919ff2ec4b8a9a59ec548e05" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_checkins" ADD CONSTRAINT "FK_55252d21afe1284f088f574e62c" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_leaves" ADD CONSTRAINT "FK_2892880548c5c37d84f6c0457e6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" ADD CONSTRAINT "FK_3f9debc31896c1b0b7c530b92a2" FOREIGN KEY ("shift_id") REFERENCES "staff_shifts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" ADD CONSTRAINT "FK_212a1308da25478d69d1df144fb" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" ADD CONSTRAINT "FK_0e27a275eaa9cd5f4f6fea1dc90" FOREIGN KEY ("absent_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" ADD CONSTRAINT "FK_d6cb48149a132ffc6d05f078676" FOREIGN KEY ("substitute_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "staff_substitutions" DROP CONSTRAINT "FK_d6cb48149a132ffc6d05f078676"`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" DROP CONSTRAINT "FK_0e27a275eaa9cd5f4f6fea1dc90"`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" DROP CONSTRAINT "FK_212a1308da25478d69d1df144fb"`);
        await queryRunner.query(`ALTER TABLE "staff_substitutions" DROP CONSTRAINT "FK_3f9debc31896c1b0b7c530b92a2"`);
        await queryRunner.query(`ALTER TABLE "staff_leaves" DROP CONSTRAINT "FK_2892880548c5c37d84f6c0457e6"`);
        await queryRunner.query(`ALTER TABLE "staff_checkins" DROP CONSTRAINT "FK_55252d21afe1284f088f574e62c"`);
        await queryRunner.query(`ALTER TABLE "staff_shift_assignments" DROP CONSTRAINT "FK_f00919ff2ec4b8a9a59ec548e05"`);
        await queryRunner.query(`ALTER TABLE "staff_shift_assignments" DROP CONSTRAINT "FK_f5133e84764accab00ba01e2b6d"`);
        await queryRunner.query(`ALTER TABLE "staff_shift_assignments" DROP CONSTRAINT "FK_9b2aecfaff5d4619856580aac01"`);
        await queryRunner.query(`DROP INDEX "public"."uq_substitution_slot"`);
        await queryRunner.query(`DROP TABLE "staff_substitutions"`);
        await queryRunner.query(`DROP TABLE "staff_leaves"`);
        await queryRunner.query(`DROP INDEX "public"."uq_staff_checkin_day"`);
        await queryRunner.query(`DROP TABLE "staff_checkins"`);
        await queryRunner.query(`DROP INDEX "public"."uq_staff_assignment"`);
        await queryRunner.query(`DROP TABLE "staff_shift_assignments"`);
        await queryRunner.query(`DROP TABLE "staff_shifts"`);
    }

}
