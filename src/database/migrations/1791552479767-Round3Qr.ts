import { MigrationInterface, QueryRunner } from "typeorm";

export class Round3Qr1791552479767 implements MigrationInterface {
    name = 'Round3Qr1791552479767'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "transfer_claims" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "invoice_id" uuid NOT NULL, "child_id" uuid NOT NULL, "amount" integer NOT NULL, "transferred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "note" character varying(500), "status" character varying(20) NOT NULL DEFAULT 'pending_confirmation', "on_behalf" boolean NOT NULL DEFAULT false, "claimed_by" uuid, "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "reject_reason" character varying(500), "payment_id" uuid, CONSTRAINT "PK_3bd8c36241ccd6526bd01322247" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7e6e7f240df67d978e3180b844" ON "transfer_claims" ("invoice_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab448aaa7419641ef52a708702" ON "transfer_claims" ("child_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0ab1cef21bcccb82d1a8523b03" ON "transfer_claims" ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_transfer_claim_pending" ON "transfer_claims" ("invoice_id") WHERE status = 'pending_confirmation'`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" ADD CONSTRAINT "FK_7e6e7f240df67d978e3180b8446" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" ADD CONSTRAINT "FK_ab448aaa7419641ef52a7087027" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" ADD CONSTRAINT "FK_c125e9ce9cc4cd1faaddd0ac2af" FOREIGN KEY ("claimed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" ADD CONSTRAINT "FK_b3f77fd931f74f82d2d57234d55" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" ADD CONSTRAINT "FK_a2ad88b1d83b804c1952decd6a2" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "transfer_claims" DROP CONSTRAINT "FK_a2ad88b1d83b804c1952decd6a2"`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" DROP CONSTRAINT "FK_b3f77fd931f74f82d2d57234d55"`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" DROP CONSTRAINT "FK_c125e9ce9cc4cd1faaddd0ac2af"`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" DROP CONSTRAINT "FK_ab448aaa7419641ef52a7087027"`);
        await queryRunner.query(`ALTER TABLE "transfer_claims" DROP CONSTRAINT "FK_7e6e7f240df67d978e3180b8446"`);
        await queryRunner.query(`DROP INDEX "public"."uq_transfer_claim_pending"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0ab1cef21bcccb82d1a8523b03"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ab448aaa7419641ef52a708702"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7e6e7f240df67d978e3180b844"`);
        await queryRunner.query(`DROP TABLE "transfer_claims"`);
    }

}
