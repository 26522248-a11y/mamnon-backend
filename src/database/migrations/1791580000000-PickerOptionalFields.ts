import { MigrationInterface, QueryRunner } from 'typeorm';

/** U5: a pickup person needs only name + phone; relation, photo and ID number become optional (photo can be taken by the teacher at the first pickup). */
export class PickerOptionalFields1791580000000 implements MigrationInterface {
  name = 'PickerOptionalFields1791580000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "authorized_pickers" ALTER COLUMN "relation" DROP NOT NULL`);
    await q.query(`ALTER TABLE "authorized_pickers" ALTER COLUMN "photo_url" DROP NOT NULL`);
    await q.query(`ALTER TABLE "authorized_pickers" ALTER COLUMN "id_number" DROP NOT NULL`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "authorized_pickers" SET "relation" = COALESCE("relation", 'Khác'), "id_number" = COALESCE("id_number", ''), "photo_url" = COALESCE("photo_url", '')`);
    await q.query(`ALTER TABLE "authorized_pickers" ALTER COLUMN "relation" SET NOT NULL`);
    await q.query(`ALTER TABLE "authorized_pickers" ALTER COLUMN "photo_url" SET NOT NULL`);
    await q.query(`ALTER TABLE "authorized_pickers" ALTER COLUMN "id_number" SET NOT NULL`);
  }
}
