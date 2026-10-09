import { MigrationInterface, QueryRunner } from "typeorm";

export class FeesHealth1791544991675 implements MigrationInterface {
    name = 'FeesHealth1791544991675'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "fee_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(120) NOT NULL, "amount" integer NOT NULL, "type" character varying(20) NOT NULL DEFAULT 'monthly', "scope" character varying(20) NOT NULL DEFAULT 'school', "class_id" uuid, "child_id" uuid, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_4ce7181a0ac3570405af9c3c736" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1fba3926bdecfb276964714c5a" ON "fee_items" ("class_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_79a7ec9a8c6c985e81e3b5a3ed" ON "fee_items" ("child_id") `);
        await queryRunner.query(`CREATE TABLE "invoices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "invoice_no" character varying(30) NOT NULL, "child_id" uuid NOT NULL, "class_id" uuid, "period" character varying(7) NOT NULL, "issue_date" date NOT NULL, "due_date" date NOT NULL, "total_amount" integer NOT NULL, "paid_amount" integer NOT NULL DEFAULT '0', "status" character varying(10) NOT NULL DEFAULT 'unpaid', "note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_invoice_child_period" UNIQUE ("child_id", "period"), CONSTRAINT "PK_668cef7c22a427fd822cc1be3ce" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_37669c562a2525929927d9d691" ON "invoices" ("invoice_no") `);
        await queryRunner.query(`CREATE INDEX "IDX_162bc515d453a45e1a4705ec80" ON "invoices" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_cfc485690cef0e71cd8a75ac0c" ON "invoices" ("period") `);
        await queryRunner.query(`CREATE INDEX "IDX_ac0f09364e3701d9ed35435288" ON "invoices" ("status") `);
        await queryRunner.query(`CREATE TABLE "invoice_lines" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "invoice_id" uuid NOT NULL, "fee_item_id" uuid, "description" character varying(200) NOT NULL, "quantity" integer NOT NULL DEFAULT '1', "unit_price" integer NOT NULL, "amount" integer NOT NULL, CONSTRAINT "PK_3d18eb48142b916f581f0c21a65" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2da95dc86a54a00ff20ce46d0f" ON "invoice_lines" ("invoice_id") `);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "receipt_no" character varying(30) NOT NULL, "invoice_id" uuid NOT NULL, "amount" integer NOT NULL, "method" character varying(20) NOT NULL, "paid_at" TIMESTAMP WITH TIME ZONE NOT NULL, "payer_name" character varying(120), "note" text, "received_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3b98272cba74c32fe41248e7e3" ON "payments" ("receipt_no") `);
        await queryRunner.query(`CREATE INDEX "IDX_563a5e248518c623eebd987d43" ON "payments" ("invoice_id") `);
        await queryRunner.query(`CREATE TABLE "growth_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "date" date NOT NULL, "height_cm" numeric(5,1), "weight_kg" numeric(5,2), "note" text, "recorded_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_growth_child_date" UNIQUE ("child_id", "date"), CONSTRAINT "PK_7c1f103d898da6153bb7a092b6c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4df60e5af6e0239886dab7b029" ON "growth_records" ("child_id") `);
        await queryRunner.query(`CREATE TABLE "menus" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "date" date NOT NULL, "meal" character varying(20) NOT NULL, "dishes" text NOT NULL, "updated_by" uuid, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_menu_date_meal" UNIQUE ("date", "meal"), CONSTRAINT "PK_3fec3d93327f4538e0cbd4349c4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_01004be7b27f66d8d15936dbfa" ON "menus" ("date") `);
        await queryRunner.query(`CREATE TABLE "daily_notes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "class_id" uuid NOT NULL, "date" date NOT NULL, "eating" character varying(10), "sleep_minutes" integer, "mood" character varying(40), "toilet" character varying(40), "note" text, "recorded_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_daily_note_child_date" UNIQUE ("child_id", "date"), CONSTRAINT "PK_20da0c697ccd5d7af52f013f0c1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3ba42447bb9eac741558b63b98" ON "daily_notes" ("class_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b673e776a3ad108d2409a23348" ON "daily_notes" ("date") `);
        await queryRunner.query(`ALTER TABLE "fee_items" ADD CONSTRAINT "FK_1fba3926bdecfb276964714c5ae" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "fee_items" ADD CONSTRAINT "FK_79a7ec9a8c6c985e81e3b5a3ed0" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "FK_162bc515d453a45e1a4705ec802" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "FK_5d8627d03264d2cf096916e4e1c" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" ADD CONSTRAINT "FK_2da95dc86a54a00ff20ce46d0fe" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" ADD CONSTRAINT "FK_2a701d49b8ed94f7e52c76ac898" FOREIGN KEY ("fee_item_id") REFERENCES "fee_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_563a5e248518c623eebd987d43e" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_addd19c06574aa904472b8c82bd" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "growth_records" ADD CONSTRAINT "FK_4df60e5af6e0239886dab7b0290" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "daily_notes" ADD CONSTRAINT "FK_4074bedb6932fedda86c7f37dda" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "daily_notes" ADD CONSTRAINT "FK_3ba42447bb9eac741558b63b988" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "daily_notes" DROP CONSTRAINT "FK_3ba42447bb9eac741558b63b988"`);
        await queryRunner.query(`ALTER TABLE "daily_notes" DROP CONSTRAINT "FK_4074bedb6932fedda86c7f37dda"`);
        await queryRunner.query(`ALTER TABLE "growth_records" DROP CONSTRAINT "FK_4df60e5af6e0239886dab7b0290"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_addd19c06574aa904472b8c82bd"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_563a5e248518c623eebd987d43e"`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" DROP CONSTRAINT "FK_2a701d49b8ed94f7e52c76ac898"`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" DROP CONSTRAINT "FK_2da95dc86a54a00ff20ce46d0fe"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "FK_5d8627d03264d2cf096916e4e1c"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "FK_162bc515d453a45e1a4705ec802"`);
        await queryRunner.query(`ALTER TABLE "fee_items" DROP CONSTRAINT "FK_79a7ec9a8c6c985e81e3b5a3ed0"`);
        await queryRunner.query(`ALTER TABLE "fee_items" DROP CONSTRAINT "FK_1fba3926bdecfb276964714c5ae"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b673e776a3ad108d2409a23348"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3ba42447bb9eac741558b63b98"`);
        await queryRunner.query(`DROP TABLE "daily_notes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_01004be7b27f66d8d15936dbfa"`);
        await queryRunner.query(`DROP TABLE "menus"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4df60e5af6e0239886dab7b029"`);
        await queryRunner.query(`DROP TABLE "growth_records"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_563a5e248518c623eebd987d43"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3b98272cba74c32fe41248e7e3"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2da95dc86a54a00ff20ce46d0f"`);
        await queryRunner.query(`DROP TABLE "invoice_lines"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ac0f09364e3701d9ed35435288"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cfc485690cef0e71cd8a75ac0c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_162bc515d453a45e1a4705ec80"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_37669c562a2525929927d9d691"`);
        await queryRunner.query(`DROP TABLE "invoices"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_79a7ec9a8c6c985e81e3b5a3ed"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1fba3926bdecfb276964714c5a"`);
        await queryRunner.query(`DROP TABLE "fee_items"`);
    }

}
