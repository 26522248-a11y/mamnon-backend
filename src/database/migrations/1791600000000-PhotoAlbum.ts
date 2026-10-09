import { MigrationInterface, QueryRunner } from 'typeorm';

/** A1 (round3 §2): class photo album. Photos tagging a child without photo consent cannot be posted unless saved hidden for that child. */
export class PhotoAlbum1791600000000 implements MigrationInterface {
  name = 'PhotoAlbum1791600000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "photo_posts" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "class_id" uuid NOT NULL REFERENCES "classes"("id") ON DELETE CASCADE,
      "author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL, "caption" varchar(300), "created_at" timestamptz NOT NULL DEFAULT now(), "deleted_at" timestamptz)`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_photo_posts_class" ON "photo_posts" ("class_id", "created_at" DESC)`);
    await q.query(`CREATE TABLE IF NOT EXISTS "photos" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "post_id" uuid NOT NULL REFERENCES "photo_posts"("id") ON DELETE CASCADE,
      "class_id" uuid NOT NULL REFERENCES "classes"("id") ON DELETE CASCADE, "author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
      "client_id" varchar(80), "full_key" varchar(250) NOT NULL, "thumb_key" varchar(250) NOT NULL, "width" int, "height" int,
      "child_ids" uuid[] NOT NULL DEFAULT '{}', "hidden" boolean NOT NULL DEFAULT false, "hidden_reason" varchar(40),
      "hidden_for_child_ids" uuid[] NOT NULL DEFAULT '{}', "hidden_at" timestamptz, "position" int NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(), "deleted_at" timestamptz)`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_photos_post" ON "photos" ("post_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_photos_child_ids" ON "photos" USING gin ("child_ids")`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_photos_author_client" ON "photos" ("author_id", "client_id") WHERE "client_id" IS NOT NULL`);
    await q.query(`CREATE TABLE IF NOT EXISTS "photo_likes" ("post_id" uuid NOT NULL REFERENCES "photo_posts"("id") ON DELETE CASCADE,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "created_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("post_id", "user_id"))`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "photo_likes"`); await q.query(`DROP TABLE IF EXISTS "photos"`); await q.query(`DROP TABLE IF EXISTS "photo_posts"`);
  }
}
