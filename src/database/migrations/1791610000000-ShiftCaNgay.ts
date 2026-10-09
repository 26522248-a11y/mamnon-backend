import { MigrationInterface, QueryRunner } from 'typeorm';

/** G9: the school has one day shift – rename existing "Ca sáng" shifts to "Ca ngày". */
export class ShiftCaNgay1791610000000 implements MigrationInterface {
  name = 'ShiftCaNgay1791610000000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "staff_shifts" SET "name" = 'Ca ngày' WHERE lower(btrim("name")) = 'ca sáng'`);
  }
  public async down(): Promise<void> { /* name change only; not reverted */ }
}
