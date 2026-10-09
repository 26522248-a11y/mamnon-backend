process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
import { DataSource } from 'typeorm';
import dataSource from '../src/database/data-source';
import { demoLoad, demoLoaded, demoPurge } from '../src/database/demo';
import { seed } from '../src/database/seed';

/** demo:load adds a marked dataset; demo:purge removes exactly it and nothing else. */
describe('demo dataset load/purge', () => {
  let ds: DataSource;
  const counts = async () => Object.fromEntries(await Promise.all(['users', 'classes', 'children', 'guardians', 'attendance', 'daily_notes', 'invoices', 'payments', 'invoice_lines',
    'fee_items', 'staff_shifts', 'staff_shift_assignments', 'staff_checkins', 'staff_leaves', 'staff_substitutions', 'finance_entries', 'announcements', 'notifications', 'menus', 'class_teachers']
    .map(async (t) => [t, Number((await ds.query(`SELECT COUNT(*)::int AS n FROM "${t}"`))[0].n)])));
  beforeAll(async () => { ds = await dataSource.initialize(); await ds.runMigrations(); await seed(ds); await ds.query('DELETE FROM menus'); });
  afterAll(async () => { await ds?.destroy(); });

  it('load → marked rows; second load refused; purge → back to exactly the previous data', async () => {
    const before = await counts();
    const r = await demoLoad(ds);
    expect(r.children).toBe(27);
    const mid = await counts();
    expect(mid.children).toBe(before.children + 27);
    expect(mid.users).toBe(before.users + 2);
    expect(mid.classes).toBe(before.classes); // Mầm 1 / Chồi 1 / Lá 1 already exist in seed → reused
    for (const t of ['attendance', 'invoices', 'staff_checkins', 'staff_leaves', 'staff_substitutions', 'finance_entries', 'announcements', 'menus']) expect(mid[t as keyof typeof mid]).toBeGreaterThan(before[t]);
    expect(Number((await ds.query(`SELECT COUNT(*)::int AS n FROM finance_entries WHERE status = 'pending' AND amount > 10000000`))[0].n)).toBeGreaterThanOrEqual(1);
    expect((await ds.query(`SELECT status FROM announcements WHERE title = 'Nhắc lịch khám sức khoẻ định kỳ'`))[0].status).toBe('scheduled');
    expect(await demoLoaded(ds)).toBeGreaterThan(100);
    await expect(demoLoad(ds)).rejects.toThrow(/already loaded/);
    // tester activity on demo data after loading (unregistered rows) must not block the purge
    const kid = (await ds.query(`SELECT c.id FROM children c JOIN demo_registry r ON r.table_name = 'children' AND r.row_id = c.id::text LIMIT 1`))[0].id;
    const inv = (await ds.query(`SELECT id FROM invoices WHERE child_id = $1 AND status <> 'paid' LIMIT 1`, [kid]))[0].id;
    await ds.query(`INSERT INTO payments (receipt_no, invoice_id, child_id, amount, method, paid_at) VALUES ('PT-TESTER-1', $1, $2, 1000, 'cash', now())`, [inv, kid]);
    // demo parent login + sensitive-change audit row on a demo child (created after load, not registered)
    const [pu] = await ds.query(`INSERT INTO users (username, name, role, password_hash) VALUES ('demo_ph_test', 'PH demo', 'parent', 'x') RETURNING id`);
    await ds.query(`INSERT INTO guardians (child_id, full_name, relation, user_id, can_pickup) VALUES ($1, 'PH demo', 'Mẹ', $2, true)`, [kid, pu.id]);
    await ds.query(`INSERT INTO audit_events (action, entity, entity_id, child_id, actor_id) VALUES ('child.photo_consent', 'child', $1, $1, NULL)`, [kid]).catch(() => undefined);
    const p = await demoPurge(ds);
    expect(p.left).toBe(0);
    expect(await counts()).toEqual(before);
    expect(await demoLoaded(ds)).toBe(0);
    expect((await ds.query(`SELECT 1 FROM users WHERE username = 'demo_ph_test'`)).length).toBe(0);
    expect((await ds.query(`SELECT username FROM users WHERE username IN ('admin','gv1','ketoan','ph1')`)).length).toBe(4);
  });
});
