import { MigrationInterface, QueryRunner } from "typeorm";

export class WithdrawalPayouts1791545891476 implements MigrationInterface {
    name = 'WithdrawalPayouts1791545891476'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "refund_payouts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "voucher_no" character varying(30) NOT NULL, "child_id" uuid NOT NULL, "amount" integer NOT NULL, "method" character varying(20) NOT NULL, "paid_at" TIMESTAMP WITH TIME ZONE NOT NULL, "recipient_name" character varying(120) NOT NULL, "note" text, "credit_tx_id" uuid, "paid_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_614e56486e2ffd0f261b3d70e19" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_60c75b7f1f973e357bd6c3da8f" ON "refund_payouts" ("voucher_no") `);
        await queryRunner.query(`CREATE INDEX "IDX_06b209cda57eb30bf40e8aa553" ON "refund_payouts" ("child_id") `);
        await queryRunner.query(`ALTER TABLE "users" ADD "must_change_password" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "children" ADD "leave_date" date`);
        await queryRunner.query(`ALTER TABLE "children" ADD "withdrawal_reason" text`);
        await queryRunner.query(`ALTER TABLE "children" ADD "withdrawn_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "children" ADD "withdrawn_by" uuid`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD "credit_tx_id" uuid`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD "reversed_by_credit_tx_id" uuid`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP CONSTRAINT "FK_c4c5cd9eb9dab27b6de7b481f1c"`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ALTER COLUMN "invoice_line_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD CONSTRAINT "FK_c4c5cd9eb9dab27b6de7b481f1c" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "refund_payouts" ADD CONSTRAINT "FK_06b209cda57eb30bf40e8aa5531" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "refund_payouts" ADD CONSTRAINT "FK_1f31a926c861236181b9f6b967f" FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        // hand-written: data-preserving changes only
        await queryRunner.query(`DROP INDEX "public"."uq_meal_refund_active"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_meal_refund_active" ON "meal_refunds" ("attendance_id") WHERE reversed_by_line_id IS NULL AND reversed_by_credit_tx_id IS NULL`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD CONSTRAINT "ck_meal_refund_target" CHECK (invoice_line_id IS NOT NULL OR credit_tx_id IS NOT NULL)`);
        await queryRunner.query(`UPDATE "children" SET status = 'withdrawn' WHERE status = 'left'`);
        await queryRunner.query(`ALTER TABLE "children" ADD CONSTRAINT "ck_child_status" CHECK (status IN ('active','withdrawn'))`);
        await queryRunner.query(`ALTER TABLE "refund_payouts" ADD CONSTRAINT "ck_payout_amount" CHECK (amount > 0)`);
        await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS payout_no_seq`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP SEQUENCE IF EXISTS payout_no_seq`);
        await queryRunner.query(`ALTER TABLE "children" DROP CONSTRAINT "ck_child_status"`);
        await queryRunner.query(`UPDATE "children" SET status = 'left' WHERE status = 'withdrawn'`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP CONSTRAINT "ck_meal_refund_target"`);
        await queryRunner.query(`DROP INDEX "public"."uq_meal_refund_active"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_meal_refund_active" ON "meal_refunds" ("attendance_id") WHERE reversed_by_line_id IS NULL`);
        await queryRunner.query(`ALTER TABLE "refund_payouts" DROP CONSTRAINT "FK_1f31a926c861236181b9f6b967f"`);
        await queryRunner.query(`ALTER TABLE "refund_payouts" DROP CONSTRAINT "FK_06b209cda57eb30bf40e8aa5531"`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP CONSTRAINT "FK_c4c5cd9eb9dab27b6de7b481f1c"`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ALTER COLUMN "invoice_line_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" ADD CONSTRAINT "FK_c4c5cd9eb9dab27b6de7b481f1c" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP COLUMN "reversed_by_credit_tx_id"`);
        await queryRunner.query(`ALTER TABLE "meal_refunds" DROP COLUMN "credit_tx_id"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "withdrawn_by"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "withdrawn_at"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "withdrawal_reason"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "leave_date"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "must_change_password"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_06b209cda57eb30bf40e8aa553"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_60c75b7f1f973e357bd6c3da8f"`);
        await queryRunner.query(`DROP TABLE "refund_payouts"`);
    }

}
