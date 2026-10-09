import { MigrationInterface, QueryRunner } from "typeorm";

export class PickupContactPhones1791549156395 implements MigrationInterface {
    name = 'PickupContactPhones1791549156395'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "child_contact_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "child_id" uuid NOT NULL, "before" jsonb NOT NULL, "after" jsonb NOT NULL, "changed_by" uuid, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_582611503ad58ec82e1032cb92b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8b9f534a1c744fc9d3127e513d" ON "child_contact_history" ("child_id") `);
        await queryRunner.query(`ALTER TABLE "children" ADD "contact_phone1" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "children" ADD "contact_phone2" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "children" ADD "contact_phones_updated_by" uuid`);
        await queryRunner.query(`ALTER TABLE "children" ADD "contact_phones_updated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "child_contact_history" ADD CONSTRAINT "FK_8b9f534a1c744fc9d3127e513dc" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "child_contact_history" ADD CONSTRAINT "FK_8fcf624fbd314e6611c65161d65" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "child_contact_history" DROP CONSTRAINT "FK_8fcf624fbd314e6611c65161d65"`);
        await queryRunner.query(`ALTER TABLE "child_contact_history" DROP CONSTRAINT "FK_8b9f534a1c744fc9d3127e513dc"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "contact_phones_updated_at"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "contact_phones_updated_by"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "contact_phone2"`);
        await queryRunner.query(`ALTER TABLE "children" DROP COLUMN "contact_phone1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8b9f534a1c744fc9d3127e513d"`);
        await queryRunner.query(`DROP TABLE "child_contact_history"`);
    }

}
