import { MigrationInterface, QueryRunner } from "typeorm";

export class Round21791550454941 implements MigrationInterface {
    name = 'Round21791550454941'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "absences" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "class_id" uuid, "from_date" date NOT NULL, "to_date" date NOT NULL, "reason" character varying(10) NOT NULL, "note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cancelled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_bd79346866fea8ac6f269252748" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7ce0717dfa1e7931fb523700ba" ON "absences" ("child_id") `);
        await queryRunner.query(`CREATE TABLE "absence_days" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "absence_id" uuid NOT NULL, "child_id" uuid NOT NULL, "date" date NOT NULL, "refund_eligible" boolean NOT NULL DEFAULT false, "overridden" boolean NOT NULL DEFAULT false, "overridden_by" uuid, "overridden_at" TIMESTAMP WITH TIME ZONE, "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by" uuid, CONSTRAINT "PK_f1ed343ffd44026c942af1f06d4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a3d7c0ece73330b05bf6a38f51" ON "absence_days" ("absence_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_44418b66259c0f91b971409b27" ON "absence_days" ("date") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_absence_day_active" ON "absence_days" ("child_id", "date") WHERE cancelled_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "absence_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "absence_id" uuid NOT NULL, "action" character varying(20) NOT NULL, "dates" jsonb NOT NULL, "actor_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_78afceabae176a813f5ca149821" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3c0afed36cdbc378dc72ead040" ON "absence_events" ("absence_id") `);
        await queryRunner.query(`CREATE TABLE "holidays" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" date NOT NULL, "name" character varying(120) NOT NULL, "kind" character varying(10) NOT NULL DEFAULT 'school', "status" character varying(10) NOT NULL DEFAULT 'confirmed', "confirmed_by" uuid, "confirmed_at" TIMESTAMP WITH TIME ZONE, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3646bdd4c3817d954d830881dfe" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_40dfddee0c0d7125c767d8962b" ON "holidays" ("date") `);
        await queryRunner.query(`CREATE TABLE "medicines" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "class_id" uuid, "date" date NOT NULL, "name" character varying(120) NOT NULL, "dose" character varying(120) NOT NULL, "note" text, "photo_url" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by" uuid, CONSTRAINT "PK_77b93851766f7ab93f71f44b18b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c236f015abaf201935ea3cee29" ON "medicines" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_01ede2077575f4f0802e5139b1" ON "medicines" ("date") `);
        await queryRunner.query(`CREATE TABLE "medicine_doses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "medicine_id" uuid NOT NULL, "time" character varying(5) NOT NULL, "label" character varying(60), "given_at" TIMESTAMP WITH TIME ZONE, "given_by" uuid, "given_note" text, CONSTRAINT "PK_721200fb85f9be71c5c9100412c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_46fcd5b24d93d50dd2d90c7938" ON "medicine_doses" ("medicine_id") `);
        await queryRunner.query(`CREATE TABLE "late_pickups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "class_id" uuid, "date" date NOT NULL, "time" character varying(5) NOT NULL, "picker_name" character varying(120), "note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by" uuid, CONSTRAINT "PK_7e2870048bfc6ef6958b1845fe3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f288931274cc01ffa8dacbe9be" ON "late_pickups" ("date") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_late_pickup_active" ON "late_pickups" ("child_id", "date") WHERE cancelled_at IS NULL`);
        await queryRunner.query(`ALTER TABLE "children" ADD "photo_consent" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "children" ADD "photo_consent_updated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "children" ADD "photo_consent_updated_by" uuid`);
        await queryRunner.query(`ALTER TABLE "attendance" ADD "absence_reason" character varying(10)`);
        await queryRunner.query(`ALTER TABLE "attendance" ADD "absence_id" uuid`);
        await queryRunner.query(`ALTER TABLE "daily_notes" ADD "breakfast" character varying(10)`);
        await queryRunner.query(`CREATE INDEX "IDX_e46bd6c47f4e32a35296a95315" ON "attendance" ("absence_id") `);
        await queryRunner.query(`ALTER TABLE "attendance" ADD CONSTRAINT "FK_e46bd6c47f4e32a35296a95315b" FOREIGN KEY ("absence_id") REFERENCES "absences"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "absences" ADD CONSTRAINT "FK_7ce0717dfa1e7931fb523700ba7" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "absence_days" ADD CONSTRAINT "FK_a3d7c0ece73330b05bf6a38f51a" FOREIGN KEY ("absence_id") REFERENCES "absences"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "absence_events" ADD CONSTRAINT "FK_3c0afed36cdbc378dc72ead0403" FOREIGN KEY ("absence_id") REFERENCES "absences"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "medicines" ADD CONSTRAINT "FK_c236f015abaf201935ea3cee290" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "medicine_doses" ADD CONSTRAINT "FK_46fcd5b24d93d50dd2d90c79380" FOREIGN KEY ("medicine_id") REFERENCES "medicines"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "late_pickups" ADD CONSTRAINT "FK_2c8dd8b00ae2f97d9be3e49265f" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "late_pickups" DROP CONSTRAINT "FK_2c8dd8b00ae2f97d9be3e49265f"`);
        await queryRunner.query(`ALTER TABLE "medicine_doses" DROP CONSTRAINT "FK_46fcd5b24d93d50dd2d90c79380"`);
        await queryRunner.query(`ALTER TABLE "medicines" DROP CONSTRAINT "FK_c236f015abaf201935ea3cee290"`);
        await queryRunner.query(`ALTER TABLE "absence_events" DROP CONSTRAINT "FK_3c0afed36cdbc378dc72ead0403"`);
        await queryRunner.query(`ALTER TABLE "absence_days" DROP CONSTRAINT "FK_a3d7c0ece73330b05bf6a38f51a"`);
        await queryRunner.query(`ALTER TABLE "absences" DROP CONSTRAINT "FK_7ce0717dfa1e7931fb523700ba7"`);
        await queryRunner.query(`ALTER TABLE "attendance" DROP CONSTRAINT "FK_e46bd6c47f4e32a35296a95315b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e46bd6c47f4e32a35296a95315"`);
        await queryRunner.query(`ALTER TABLE "daily_notes" DROP COLUMN "breakfast"`);
        await queryRunner.query(`ALTER TABLE "attendance" DROP COLUMN "absence_id"`);
        await queryRunner.query(`ALTER TABLE "attendance" DROP COLUMN "absence_reason"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "photo_consent_updated_by"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "photo_consent_updated_at"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "photo_consent"`);
        await queryRunner.query(`DROP INDEX "public"."uq_late_pickup_active"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f288931274cc01ffa8dacbe9be"`);
        await queryRunner.query(`DROP TABLE "late_pickups"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_46fcd5b24d93d50dd2d90c7938"`);
        await queryRunner.query(`DROP TABLE "medicine_doses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_01ede2077575f4f0802e5139b1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c236f015abaf201935ea3cee29"`);
        await queryRunner.query(`DROP TABLE "medicines"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_40dfddee0c0d7125c767d8962b"`);
        await queryRunner.query(`DROP TABLE "holidays"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3c0afed36cdbc378dc72ead040"`);
        await queryRunner.query(`DROP TABLE "absence_events"`);
        await queryRunner.query(`DROP INDEX "public"."uq_absence_day_active"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_44418b66259c0f91b971409b27"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a3d7c0ece73330b05bf6a38f51"`);
        await queryRunner.query(`DROP TABLE "absence_days"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7ce0717dfa1e7931fb523700ba"`);
        await queryRunner.query(`DROP TABLE "absences"`);
    }

}
