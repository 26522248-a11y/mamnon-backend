import { MigrationInterface, QueryRunner } from 'typeorm';

/** U10: optional hand-over photo on pickups. */
export class PickupPhoto1791570000000 implements MigrationInterface {
  name = 'PickupPhoto1791570000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "pickups" ADD COLUMN IF NOT EXISTS "photo_url" text`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "pickups" DROP COLUMN IF EXISTS "photo_url"`);
  }
}
