/**
 * One-off repair (bug fixed in fees.controller withdraw step 3): credit applied to already-issued invoices during
 * POST /children/:id/withdraw was stored as a 'credit' LINE that lowered invoices.total_amount. Correct: total unchanged,
 * paid_amount increased. For each such line: total += X, paid += X, status recomputed, line removed, audit row added.
 * The credit_transactions 'applied' rows were already correct and are not touched.
 *   npm run repair:withdrawal-credit            # dry run (prints what would change)
 *   npm run repair:withdrawal-credit -- --apply # apply in one transaction; log written to logs/
 */
import * as fs from 'fs';
import * as path from 'path';
import dataSource from './data-source';

const DESC = 'Trừ số dư khi tất toán nghỉ học';
const statusOf = (total: number, paid: number) => (total === 0 || paid >= total ? 'paid' : paid <= 0 ? 'unpaid' : 'partial');

(async () => {
  const apply = process.argv.includes('--apply');
  await dataSource.initialize();
  const changes: any[] = [];
  await dataSource.transaction(async (m) => {
    const rows: any[] = await m.query(`
      SELECT l.id AS line_id, -l.amount AS amount, i.id AS invoice_id, i.invoice_no, i.total_amount, i.paid_amount, i.status, c.full_name
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id JOIN children c ON c.id = i.child_id
      WHERE l.kind = 'credit' AND l.description = $1 ORDER BY i.invoice_no FOR UPDATE OF i`, [DESC]);
    for (const r of rows) {
      const inv: any = (await m.query('SELECT total_amount, paid_amount, status FROM invoices WHERE id = $1', [r.invoice_id]))[0];
      const total = inv.total_amount + r.amount, paid = inv.paid_amount + r.amount, status = r.status === 'void' ? 'void' : statusOf(total, paid);
      const ch = { invoiceNo: r.invoice_no, child: r.full_name, lineId: r.line_id, creditApplied: r.amount,
        before: { total: inv.total_amount, paid: inv.paid_amount, status: inv.status }, after: { total, paid, status } };
      changes.push(ch);
      if (!apply) continue;
      await m.query('DELETE FROM invoice_lines WHERE id = $1', [r.line_id]);
      await m.query('UPDATE invoices SET total_amount = $2, paid_amount = $3, status = $4, updated_at = now() WHERE id = $1', [r.invoice_id, total, paid, status]);
      await m.query(`INSERT INTO invoice_audit (invoice_id, action, line_id, old_value, new_value, changed_by) VALUES ($1, 'credit_applied', $2, $3, $4, NULL)`,
        [r.invoice_id, r.line_id, JSON.stringify({ ...ch.before, creditLine: -r.amount }), JSON.stringify({ ...ch.after, creditApplied: r.amount, reason: 'repair: withdrawal credit counted as payment, total restored' })]);
    }
  });
  const out = { at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', count: changes.length, changes };
  console.log(JSON.stringify(out, null, 2));
  if (apply) {
    const dir = path.resolve(process.cwd(), 'logs'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `repair-withdrawal-credit_${out.at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(out, null, 2)); console.log('log:', f);
  }
  await dataSource.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
