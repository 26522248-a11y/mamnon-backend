import { MigrationInterface, QueryRunner } from "typeorm";

export class Round3Photos1791552752771 implements MigrationInterface {
    name = 'Round3Photos1791552752771'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "photo_posts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "class_id" uuid NOT NULL, "caption" character varying(300), "author_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "deleted_by" uuid, CONSTRAINT "PK_472d80642785673b56eaaeb041d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_photo_posts_class_created" ON "photo_posts" ("class_id", "created_at") `);
        await queryRunner.query(`CREATE TABLE "photos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "post_id" uuid NOT NULL, "class_id" uuid NOT NULL, "position" integer NOT NULL DEFAULT '0', "file_key" character varying(120) NOT NULL, "thumb_key" character varying(120) NOT NULL, "width" integer NOT NULL, "height" integer NOT NULL, "hidden" boolean NOT NULL DEFAULT false, "hidden_reason" character varying(40), "hidden_for_child_ids" uuid array NOT NULL DEFAULT '{}', "hidden_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, "deleted_by" uuid, CONSTRAINT "PK_5220c45b8e32d49d767b9b3d725" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2fa80079f16f9dcd1f89d046e1" ON "photos" ("post_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_dcb1e8f577a3e0daeb84a199ed" ON "photos" ("class_id") `);
        await queryRunner.query(`CREATE TABLE "photo_tags" ("photo_id" uuid NOT NULL, "child_id" uuid NOT NULL, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e0d70286b145d0ad46bb88eec3a" PRIMARY KEY ("photo_id", "child_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8eb547456382adf15b6ba840a5" ON "photo_tags" ("child_id") `);
        await queryRunner.query(`CREATE TABLE "photo_likes" ("post_id" uuid NOT NULL, "user_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e3b17e1c136f9a3b499126d9700" PRIMARY KEY ("post_id", "user_id"))`);
        await queryRunner.query(`ALTER TABLE "photo_posts" ADD CONSTRAINT "FK_093ebcdf540b844315c9d012a7d" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "photo_posts" ADD CONSTRAINT "FK_52d5b82f6c64c76a5a31fe4b74a" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "photos" ADD CONSTRAINT "FK_2fa80079f16f9dcd1f89d046e1c" FOREIGN KEY ("post_id") REFERENCES "photo_posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "photo_tags" ADD CONSTRAINT "FK_a2bb7871d82754a42f7a076266c" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "photo_tags" ADD CONSTRAINT "FK_8eb547456382adf15b6ba840a54" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "photo_likes" ADD CONSTRAINT "FK_38eb5735066813a06c0549398f8" FOREIGN KEY ("post_id") REFERENCES "photo_posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "photo_likes" ADD CONSTRAINT "FK_423107c4df49250d077fb608718" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "photo_likes" DROP CONSTRAINT "FK_423107c4df49250d077fb608718"`);
        await queryRunner.query(`ALTER TABLE "photo_likes" DROP CONSTRAINT "FK_38eb5735066813a06c0549398f8"`);
        await queryRunner.query(`ALTER TABLE "photo_tags" DROP CONSTRAINT "FK_8eb547456382adf15b6ba840a54"`);
        await queryRunner.query(`ALTER TABLE "photo_tags" DROP CONSTRAINT "FK_a2bb7871d82754a42f7a076266c"`);
        await queryRunner.query(`ALTER TABLE "photos" DROP CONSTRAINT "FK_2fa80079f16f9dcd1f89d046e1c"`);
        await queryRunner.query(`ALTER TABLE "photo_posts" DROP CONSTRAINT "FK_52d5b82f6c64c76a5a31fe4b74a"`);
        await queryRunner.query(`ALTER TABLE "photo_posts" DROP CONSTRAINT "FK_093ebcdf540b844315c9d012a7d"`);
        await queryRunner.query(`DROP TABLE "photo_likes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8eb547456382adf15b6ba840a5"`);
        await queryRunner.query(`DROP TABLE "photo_tags"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dcb1e8f577a3e0daeb84a199ed"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2fa80079f16f9dcd1f89d046e1"`);
        await queryRunner.query(`DROP TABLE "photos"`);
        await queryRunner.query(`DROP INDEX "public"."ix_photo_posts_class_created"`);
        await queryRunner.query(`DROP TABLE "photo_posts"`);
    }

}
