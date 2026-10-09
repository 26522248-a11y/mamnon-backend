import { MigrationInterface, QueryRunner } from "typeorm";

export class Finance1791557748627 implements MigrationInterface {
    name = 'Finance1791557748627'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "finance_categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kind" character varying(3) NOT NULL, "name" character varying(80) NOT NULL, "sort_order" integer NOT NULL DEFAULT '0', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_finance_category_kind_name" UNIQUE ("kind", "name"), CONSTRAINT "PK_64641410dbc935db908ba2d548d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "finance_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kind" character varying(3) NOT NULL, "date" date NOT NULL, "title" character varying(200) NOT NULL, "amount" bigint NOT NULL, "category_id" uuid NOT NULL, "status" character varying(10) NOT NULL, "requires_approval" boolean NOT NULL DEFAULT false, "note" text, "receipt_key" character varying(80), "receipt_name" character varying(200), "created_by" uuid, "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_550c7243f4fb3952224a6a7616d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ce24c02a84797ba8b63fc0586b" ON "finance_entries" ("category_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ddc9be026ce6a12d4a0fb0733" ON "finance_entries" ("status") `);
        await queryRunner.query(`CREATE INDEX "ix_finance_entries_date" ON "finance_entries" ("date") `);
        await queryRunner.query(`ALTER TABLE "finance_entries" ADD CONSTRAINT "FK_ce24c02a84797ba8b63fc0586bb" FOREIGN KEY ("category_id") REFERENCES "finance_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "finance_entries" ADD CONSTRAINT "FK_b7077786e203a25c7efb0449425" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "finance_entries" ADD CONSTRAINT "FK_26058e3082a9191f1b998efbf7e" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`INSERT INTO "finance_categories" ("kind", "name", "sort_order") VALUES
            ('out', 'Lương & BH', 10), ('out', 'Tiền ăn', 20), ('out', 'Điện nước', 30), ('out', 'Đồ dùng học tập', 40), ('out', 'Sửa chữa, bảo trì', 50), ('out', 'Chi khác', 90),
            ('in', 'Thu khác', 90) ON CONFLICT DO NOTHING`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "finance_entries" DROP CONSTRAINT "FK_26058e3082a9191f1b998efbf7e"`);
        await queryRunner.query(`ALTER TABLE "finance_entries" DROP CONSTRAINT "FK_b7077786e203a25c7efb0449425"`);
        await queryRunner.query(`ALTER TABLE "finance_entries" DROP CONSTRAINT "FK_ce24c02a84797ba8b63fc0586bb"`);
        await queryRunner.query(`DROP INDEX "public"."ix_finance_entries_date"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6ddc9be026ce6a12d4a0fb0733"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ce24c02a84797ba8b63fc0586b"`);
        await queryRunner.query(`DROP TABLE "finance_entries"`);
        await queryRunner.query(`DROP TABLE "finance_categories"`);
    }

}
