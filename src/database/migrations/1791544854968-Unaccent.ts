import { MigrationInterface, QueryRunner } from 'typeorm';

/** Accent-insensitive name search ("an" matches "Ân"). unaccent is a trusted extension (PG13+), DB owner can create it. */
export class Unaccent1791544854968 implements MigrationInterface {
  name = 'Unaccent1791544854968';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP EXTENSION IF EXISTS unaccent`);
  }
}
