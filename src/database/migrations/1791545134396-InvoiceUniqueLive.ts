import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceUniqueLive1791545134396 implements MigrationInterface {
    name = 'InvoiceUniqueLive1791545134396'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "uq_invoice_child_period"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_invoice_child_period_live" ON "invoices" ("child_id", "period") WHERE status <> 'void'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_invoice_child_period_live"`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "uq_invoice_child_period" UNIQUE ("child_id", "period")`);
    }

}
