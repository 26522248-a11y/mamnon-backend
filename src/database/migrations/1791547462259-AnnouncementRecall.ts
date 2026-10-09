import { MigrationInterface, QueryRunner } from "typeorm";

export class AnnouncementRecall1791547462259 implements MigrationInterface {
    name = 'AnnouncementRecall1791547462259'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "announcements" ADD "important" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "announcements" ADD "recipient_user_ids" uuid array`);
        await queryRunner.query(`ALTER TABLE "announcements" ADD "recalled_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "announcements" ADD "recalled_by" uuid`);
        await queryRunner.query(`ALTER TABLE "announcements" ADD "recipient_count" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD "important" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD "hidden_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_e8238e51fbfbab82fe33784f81" ON "announcements" ("recalled_at") `);
        await queryRunner.query(`UPDATE announcements a SET recipient_count = (SELECT COUNT(*) FROM notifications n WHERE n.announcement_id = a.id)`);
        await queryRunner.query(`CREATE INDEX "ix_notifications_announcement" ON "notifications" ("announcement_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."ix_notifications_announcement"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e8238e51fbfbab82fe33784f81"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "hidden_at"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "important"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP COLUMN "recipient_count"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP COLUMN "recalled_by"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP COLUMN "recalled_at"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP COLUMN "recipient_user_ids"`);
        await queryRunner.query(`ALTER TABLE "announcements" DROP COLUMN "important"`);
    }

}
