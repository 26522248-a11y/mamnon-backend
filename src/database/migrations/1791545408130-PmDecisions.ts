import { MigrationInterface, QueryRunner } from "typeorm";

export class PmDecisions1791545408130 implements MigrationInterface {
    name = 'PmDecisions1791545408130'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "credit_transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "amount" integer NOT NULL, "type" character varying(20) NOT NULL, "payment_id" uuid, "invoice_id" uuid, "note" text, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a408319811d1ab32832ec86fc2c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0ce8d7ce14043f29cfdf8a353a" ON "credit_transactions" ("child_id") `);
        await queryRunner.query(`ALTER TABLE "attendance" ADD "notified_in_advance" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "fee_items" ADD "reason" text`);
        await queryRunner.query(`ALTER TABLE "fee_items" ADD "meal_refund_per_day" integer`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" ADD "kind" character varying(10) NOT NULL DEFAULT 'charge'`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" ADD "reason" text`);
        // no more negative lines: legacy negative prices become discount lines
        await queryRunner.query(`UPDATE "invoice_lines" SET kind = 'discount', unit_price = -unit_price, reason = COALESCE(reason, description) WHERE unit_price < 0`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" ADD CONSTRAINT "ck_invoice_line_price" CHECK (unit_price >= 0)`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" ADD CONSTRAINT "ck_credit_nonzero" CHECK (amount <> 0)`);
        await queryRunner.query(`ALTER TABLE "payments" ADD "child_id" uuid`);
        await queryRunner.query(`UPDATE "payments" p SET child_id = i.child_id FROM "invoices" i WHERE i.id = p.invoice_id`);
        await queryRunner.query(`ALTER TABLE "payments" ALTER COLUMN "child_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payments" ADD "credit_amount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "menus" ADD "allergy_notes" text`);
        await queryRunner.query(`ALTER TABLE "attendance_history" ADD "old_notified" boolean`);
        await queryRunner.query(`ALTER TABLE "attendance_history" ADD "new_notified" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "expires_at" TIMESTAMP WITH TIME ZONE`);
        // backfill: min(created + 2h, end of that day in Vietnam time)
        await queryRunner.query(`UPDATE "pickup_requests" SET expires_at = LEAST(created_at + interval '2 hours', ((created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" ADD "decided_on_behalf" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_563a5e248518c623eebd987d43e"`);
        await queryRunner.query(`ALTER TABLE "payments" ALTER COLUMN "invoice_id" DROP NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_5502dbbe62a4b8bab351090e7f" ON "payments" ("child_id") `);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_563a5e248518c623eebd987d43e" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_5502dbbe62a4b8bab351090e7fd" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" ADD CONSTRAINT "FK_0ce8d7ce14043f29cfdf8a353ab" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoice_lines" DROP CONSTRAINT IF EXISTS "ck_invoice_line_price"`);
        await queryRunner.query(`ALTER TABLE "credit_transactions" DROP CONSTRAINT "FK_0ce8d7ce14043f29cfdf8a353ab"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_5502dbbe62a4b8bab351090e7fd"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_563a5e248518c623eebd987d43e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5502dbbe62a4b8bab351090e7f"`);
        await queryRunner.query(`ALTER TABLE "payments" ALTER COLUMN "invoice_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_563a5e248518c623eebd987d43e" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "decided_on_behalf"`);
        await queryRunner.query(`ALTER TABLE "pickup_requests" DROP COLUMN "expires_at"`);
        await queryRunner.query(`ALTER TABLE "attendance_history" DROP COLUMN "new_notified"`);
        await queryRunner.query(`ALTER TABLE "attendance_history" DROP COLUMN "old_notified"`);
        await queryRunner.query(`ALTER TABLE "menus" DROP COLUMN "allergy_notes"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "credit_amount"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "child_id"`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" DROP COLUMN "reason"`);
        await queryRunner.query(`ALTER TABLE "invoice_lines" DROP COLUMN "kind"`);
        await queryRunner.query(`ALTER TABLE "fee_items" DROP COLUMN "meal_refund_per_day"`);
        await queryRunner.query(`ALTER TABLE "fee_items" DROP COLUMN "reason"`);
        await queryRunner.query(`ALTER TABLE "attendance" DROP COLUMN "notified_in_advance"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0ce8d7ce14043f29cfdf8a353a"`);
        await queryRunner.query(`DROP TABLE "credit_transactions"`);
    }

}
