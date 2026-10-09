import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1791544854967 implements MigrationInterface {
    name = 'Init1791544854967'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."user_role" AS ENUM('admin', 'teacher', 'accountant', 'parent')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "username" character varying(64) NOT NULL, "password_hash" character varying NOT NULL, "name" character varying(120) NOT NULL, "role" "public"."user_role" NOT NULL, "phone" character varying(20), "is_active" boolean NOT NULL DEFAULT true, "token_version" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fe0bb3f6520ee0469504521e71" ON "users" ("username") `);
        await queryRunner.query(`CREATE TABLE "classes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(80) NOT NULL, "age_group" character varying(40) NOT NULL, "school_year" character varying(20), "room" character varying(40), "capacity" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e207aa15404e9b2ce35910f9f7f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "class_teachers" ("class_id" uuid NOT NULL, "user_id" uuid NOT NULL, "is_head" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_3b1e6f600e3f882bdda4c38ab54" PRIMARY KEY ("class_id", "user_id"))`);
        await queryRunner.query(`CREATE TABLE "children" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "full_name" character varying(120) NOT NULL, "dob" date NOT NULL, "gender" character(1) NOT NULL, "class_id" uuid, "allergies" text, "health_notes" text, "address" text, "photo_url" text, "enrolled_at" date, "status" character varying(20) NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8c5a7cbebf2c702830ef38d22b0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0a1c9f5da658702c0cb055e92d" ON "children" ("full_name") `);
        await queryRunner.query(`CREATE INDEX "IDX_6de18d0aee9c88ed07d29de77c" ON "children" ("class_id") `);
        await queryRunner.query(`CREATE TABLE "guardians" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "full_name" character varying(120) NOT NULL, "relation" character varying(40) NOT NULL, "phone" character varying(20), "id_number" character varying(20), "can_pickup" boolean NOT NULL DEFAULT true, "user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3dcf02f3dc96a2c017106f280be" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_883ff67dacb49a9854b0f2cb59" ON "guardians" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f1d05a3a2d70db0a25479b6718" ON "guardians" ("user_id") `);
        await queryRunner.query(`CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'late')`);
        await queryRunner.query(`CREATE TABLE "attendance" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "class_id" uuid NOT NULL, "date" date NOT NULL, "status" "public"."attendance_status" NOT NULL, "note" text, "recorded_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_attendance_child_date" UNIQUE ("child_id", "date"), CONSTRAINT "PK_ee0ffe42c1f1a01e72b725c0cb2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e63ac3a881f4b1ff420942c217" ON "attendance" ("class_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ff05fd5159e6d9d99514d46531" ON "attendance" ("date") `);
        await queryRunner.query(`CREATE TABLE "pickups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "attendance_id" uuid NOT NULL, "guardian_id" uuid, "picked_up_by_name" character varying(120) NOT NULL, "relation" character varying(40), "picked_up_at" TIMESTAMP WITH TIME ZONE NOT NULL, "is_authorized" boolean NOT NULL, "note" text, "recorded_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_be665e5013309830aab365f6c8" UNIQUE ("attendance_id"), CONSTRAINT "PK_e1151cd3c046633d96998376f28" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_be665e5013309830aab365f6c8" ON "pickups" ("attendance_id") `);
        await queryRunner.query(`ALTER TABLE "class_teachers" ADD CONSTRAINT "FK_1192d6f4432d1de68d66e9a9cd7" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "class_teachers" ADD CONSTRAINT "FK_bd23f8c0fce7f4916ed23c7891b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "children" ADD CONSTRAINT "FK_6de18d0aee9c88ed07d29de77c9" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "guardians" ADD CONSTRAINT "FK_883ff67dacb49a9854b0f2cb59d" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "guardians" ADD CONSTRAINT "FK_f1d05a3a2d70db0a25479b67189" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "attendance" ADD CONSTRAINT "FK_246999550e7d0426639c1ebac10" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "attendance" ADD CONSTRAINT "FK_e63ac3a881f4b1ff420942c217a" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickups" ADD CONSTRAINT "FK_be665e5013309830aab365f6c8a" FOREIGN KEY ("attendance_id") REFERENCES "attendance"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickups" ADD CONSTRAINT "FK_79ca7fbc63b129dd7fd84d6a0c4" FOREIGN KEY ("guardian_id") REFERENCES "guardians"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pickups" DROP CONSTRAINT "FK_79ca7fbc63b129dd7fd84d6a0c4"`);
        await queryRunner.query(`ALTER TABLE "pickups" DROP CONSTRAINT "FK_be665e5013309830aab365f6c8a"`);
        await queryRunner.query(`ALTER TABLE "attendance" DROP CONSTRAINT "FK_e63ac3a881f4b1ff420942c217a"`);
        await queryRunner.query(`ALTER TABLE "attendance" DROP CONSTRAINT "FK_246999550e7d0426639c1ebac10"`);
        await queryRunner.query(`ALTER TABLE "guardians" DROP CONSTRAINT "FK_f1d05a3a2d70db0a25479b67189"`);
        await queryRunner.query(`ALTER TABLE "guardians" DROP CONSTRAINT "FK_883ff67dacb49a9854b0f2cb59d"`);
        await queryRunner.query(`ALTER TABLE "children" DROP CONSTRAINT "FK_6de18d0aee9c88ed07d29de77c9"`);
        await queryRunner.query(`ALTER TABLE "class_teachers" DROP CONSTRAINT "FK_bd23f8c0fce7f4916ed23c7891b"`);
        await queryRunner.query(`ALTER TABLE "class_teachers" DROP CONSTRAINT "FK_1192d6f4432d1de68d66e9a9cd7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_be665e5013309830aab365f6c8"`);
        await queryRunner.query(`DROP TABLE "pickups"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ff05fd5159e6d9d99514d46531"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e63ac3a881f4b1ff420942c217"`);
        await queryRunner.query(`DROP TABLE "attendance"`);
        await queryRunner.query(`DROP TYPE "public"."attendance_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f1d05a3a2d70db0a25479b6718"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_883ff67dacb49a9854b0f2cb59"`);
        await queryRunner.query(`DROP TABLE "guardians"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6de18d0aee9c88ed07d29de77c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0a1c9f5da658702c0cb055e92d"`);
        await queryRunner.query(`DROP TABLE "children"`);
        await queryRunner.query(`DROP TABLE "class_teachers"`);
        await queryRunner.query(`DROP TABLE "classes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fe0bb3f6520ee0469504521e71"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."user_role"`);
    }

}
