import { MigrationInterface, QueryRunner } from 'typeorm';

/** B9: scheduled announcements + image attachments. Existing rows become status 'sent' (or 'revoked' if recalled). */
export class AnnouncementSchedule1791560000000 implements MigrationInterface {
  name = 'AnnouncementSchedule1791560000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "announcements" ADD "status" character varying(10) NOT NULL DEFAULT 'sent'`);
    await q.query(`ALTER TABLE "announcements" ADD "scheduled_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "announcements" ADD "sent_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`UPDATE "announcements" SET "sent_at" = "created_at", "status" = CASE WHEN "recalled_at" IS NULL THEN 'sent' ELSE 'revoked' END`);
    await q.query(`ALTER TABLE "announcements" ADD CONSTRAINT "ck_announcement_status" CHECK ("status" IN ('scheduled','sent','revoked'))`);
    await q.query(`CREATE INDEX "IDX_announcements_status" ON "announcements" ("status")`);
    await q.query(`CREATE INDEX "IDX_announcements_scheduled_at" ON "announcements" ("scheduled_at")`);
    await q.query(`CREATE TABLE "announcement_attachments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "announcement_id" uuid, "file_key" character varying(80) NOT NULL,
      "thumb_key" character varying(80) NOT NULL, "width" integer NOT NULL, "height" integer NOT NULL, "size" integer NOT NULL, "sort_order" integer NOT NULL DEFAULT 0,
      "uploaded_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_announcement_attachments" PRIMARY KEY ("id"))`);
    await q.query(`CREATE INDEX "IDX_ann_att_announcement" ON "announcement_attachments" ("announcement_id")`);
    await q.query(`CREATE INDEX "IDX_ann_att_uploaded_by" ON "announcement_attachments" ("uploaded_by")`);
    await q.query(`ALTER TABLE "announcement_attachments" ADD CONSTRAINT "FK_ann_att_announcement" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "announcement_attachments"`);
    await q.query(`DROP INDEX "IDX_announcements_scheduled_at"`);
    await q.query(`DROP INDEX "IDX_announcements_status"`);
    await q.query(`ALTER TABLE "announcements" DROP CONSTRAINT "ck_announcement_status"`);
    await q.query(`ALTER TABLE "announcements" DROP COLUMN "sent_at"`);
    await q.query(`ALTER TABLE "announcements" DROP COLUMN "scheduled_at"`);
    await q.query(`ALTER TABLE "announcements" DROP COLUMN "status"`);
  }
}
