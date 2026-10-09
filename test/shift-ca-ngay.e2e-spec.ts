process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';
import { ShiftCaNgay1791610000000 } from '../src/database/migrations/1791610000000-ShiftCaNgay';

/** G9: existing "Ca sáng" shifts are renamed to "Ca ngày" by migration. */
describe('G9 shift rename migration', () => {
  let ds: DataSource;
  beforeAll(async () => { ds = await new DataSource(dataSourceOptions as any).initialize(); await ds.runMigrations(); });
  afterAll(async () => { await ds?.destroy(); });
  it('renames Ca sáng → Ca ngày, leaves other shifts', async () => {
    await ds.query('TRUNCATE staff_substitutions, staff_shift_assignments, staff_shifts CASCADE');
    await ds.query(`INSERT INTO staff_shifts (name, start_time, end_time) VALUES ('Ca sáng','07:00','16:30'), (' ca sáng ','07:00','11:00'), ('Ca chiều','13:00','17:00')`);
    await new ShiftCaNgay1791610000000().up(ds.createQueryRunner());
    const names = (await ds.query('SELECT name FROM staff_shifts ORDER BY start_time, end_time')).map((r: any) => r.name);
    expect(names).toEqual(['Ca ngày', 'Ca ngày', 'Ca chiều']);
  });
});
