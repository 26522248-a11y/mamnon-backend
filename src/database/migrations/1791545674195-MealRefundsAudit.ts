import { MigrationInterface, QueryRunner } from "typeorm";

export class MealRefundsAudit1791545674195 implements MigrationInterface {
    name = 'MealRefundsAudit1791545674195'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoice_lines" DROP CONSTRAINT "ck_invoice_line_price"`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" DROP CONSTRAINT "ck_credit_nonzero"`);
        await queryRunner.query(`CREATE TABLE "meal_refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "attendance_id" uuid NOT NULL, "child_id" uuid NOT NULL, "invoice_line_id" uuid NOT NULL, "amount" integer NOT NULL, "reversed_by_line_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_dcc28a3af14f149f365255c260d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e8591c768b2037d308d8be3a3d" ON "meal_refunds" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c4c5cd9eb9dab27b6de7b481f1" ON "meal_refunds" ("invoice_line_id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_meal_refund_active" ON "meal_refunds" ("attendance_id") WHERE reversed_by_line_id IS NULL`);
        await queryRunner.query(`CREATE TABLE "invoice_audit" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "invoice_id" uuid NOT NULL, "action" character varying(30) NOT NULL, "line_id" uuid, "old_value" jsonb, "new_value" jsonb, "changed_by" uuid, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8218ca17287afa602baa537ca2c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_52a3a83c92bccdcf658d7aadbe" ON "invoice_audit" ("invoice_id") `);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD CONSTRAINT "FK_6b42a7c10572a08623d29e94fd2" FOREIGN KEY ("attendance_id") REFERENCES "attendance"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD CONSTRAINT "FK_c4c5cd9eb9dab27b6de7b481f1c" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invoice_audit" ADD CONSTRAINT "FK_52a3a83c92bccdcf658d7aadbe0" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "invoice_audit" ADD CONSTRAINT "FK_2365b92e7e1d041411d84efa319" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoice_audit" DROP CONSTRAINT "FK_2365b92e7e1d041411d84efa319"`);
        await queryRunner.query(`ALTER TABLE "invoice_audit" DROP CONSTRAINT "FK_52a3a83c92bccdcf658d7aadbe0"`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP CONSTRAINT "FK_c4c5cd9eb9dab27b6de7b481f1c"`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP CONSTRAINT "FK_6b42a7c10572a08623d29e94fd2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_52a3a83c92bccdcf658d7aadbe"`);
        await queryRunner.query(`DROP TABLE "invoice_audit"`);
        await queryRunner.query(`DROP INDEX "public"."uq_meal_refund_active"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c4c5cd9eb9dab27b6de7b481f1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e8591c768b2037d308d8be3a3d"`);
        await queryRunner.query(`DROP TABLE "meal_refunds"`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" ADD CONSTRAINT "ck_credit_nonzero" CHECK ((amount <> 0))`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" ADD CONSTRAINT "ck_invoice_line_price" CHECK ((unit_price >= 0))`);
    }

}
