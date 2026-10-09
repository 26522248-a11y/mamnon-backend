import { MigrationInterface, QueryRunner } from "typeorm";

export class Notifications1791545299861 implements MigrationInterface {
    name = 'Notifications1791545299861'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "ck_invoice_amounts"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "ck_payment_amount"`);
        await queryRunner.query(`CREATE TABLE "announcements" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying(200) NOT NULL, "body" text NOT NULL, "scope" character varying(10) NOT NULL, "class_id" uuid, "audience" character varying(10) NOT NULL DEFAULT 'all', "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_b3ad760876ff2e19d58e05dc8b0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8adc55f739d19d84f29e5ffcfb" ON "announcements" ("class_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_541ba8781433f9ab045cc4330c" ON "announcements" ("created_at") `);
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "type" character varying(30) NOT NULL, "title" character varying(200) NOT NULL, "body" text, "data" jsonb, "announcement_id" uuid, "read_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9a8a82462cab47c73d25f49261" ON "notifications" ("user_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_77ee7b06d6f802000c0846f3a5" ON "notifications" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "ix_notifications_user_read" ON "notifications" ("user_id", "read_at") `);
        await queryRunner.query(`ALTER TABLE "announcements" ADD CONSTRAINT "FK_8adc55f739d19d84f29e5ffcfb4" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "announcements" ADD CONSTRAINT "FK_40bd4946a00669c5fb7e6d972f0" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_f8c344f6b38a337948bd4d7cbc1" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_f8c344f6b38a337948bd4d7cbc1"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_9a8a82462cab47c73d25f49261f"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP CONSTRAINT "FK_40bd4946a00669c5fb7e6d972f0"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP CONSTRAINT "FK_8adc55f739d19d84f29e5ffcfb4"`);
        await queryRunner.query(`DROP INDEX "public"."ix_notifications_user_read"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77ee7b06d6f802000c0846f3a5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9a8a82462cab47c73d25f49261"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_541ba8781433f9ab045cc4330c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8adc55f739d19d84f29e5ffcfb"`);
        await queryRunner.query(`DROP TABLE "announcements"`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "ck_payment_amount" CHECK ((amount > 0))`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD CONSTRAINT "ck_invoice_amounts" CHECK (((total_amount >= 0) AND (paid_amount >= 0) AND (paid_amount <= total_amount)))`);
    }

}
