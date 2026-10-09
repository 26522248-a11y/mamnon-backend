/**
 * One-off data cleanup before acceptance testing (2026-10-09). Dry run by default; `-- --apply` executes. Log -> logs/.
 *   1) ph1: delete stale pickup-request notifications created by the QA scripts (request note 'test', phone 0901234567).
 *   2) Vũ Minh Phúc: void FE test invoices HD202612-00061..HD202702-00064 with reason 'Dữ liệu test' (same code path as
 *      POST /invoices/:id/void; already-void ones are skipped). Voiding a PAID test invoice moves its test money to credit
 *      (void_refund); that test credit is then cancelled with an 'adjustment' so it is not applied to real invoices.
 *      Parent "new invoice" notifications for those invoices are deleted too.
 *   3) 0đ invoices that are a 100% discount/refund (not credit-covered) get the note 'Miễn/giảm 100%' (new rule).
 * Run with the API stopped or running – it uses its own transaction. Take a pg_dump first (see README).
 */
import * as fs from 'fs';
import * as path from 'path';
import dataSource from './data-source';

const VOID_NOS = ['HD202612-00061', 'HD202612-00062', 'HD202701-00063', 'HD202702-00064'];
const CHILD = 'Vũ Minh Phúc', REASON = 'Dữ liệu test', WAIVER = 'Miễn/giảm 100%';

(async () => {
  const apply = process.argv.includes('--apply');
  await dataSource.initialize();
  const log: any = { at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', steps: {} };
  await dataSource.transaction(async (m) => {
    // 1) ph1 pickup-request test notifications
    const notifs: any[] = await m.query(`
      SELECT n.id, n.title, n.read_at, n.created_at, pr.id AS request_id, pr.picker_name, pr.status
      FROM notifications n JOIN users u ON u.id = n.user_id
      JOIN pickup_requests pr ON pr.id::text = n.data->>'pickupRequestId'
      WHERE u.username = 'ph1' AND n.type = 'pickup_request' AND pr.note = 'test' AND pr.picker_phone = '0901234567' ORDER BY n.created_at`);
    log.steps.ph1PickupNotifications = { action: 'delete', count: notifs.length, unread: notifs.filter((n) => !n.read_at).length,
      items: notifs.map((n) => ({ id: n.id, requestId: n.request_id, picker: n.picker_name, requestStatus: n.status, createdAt: n.created_at })) };
    if (apply && notifs.length) await m.query('DELETE FROM notifications WHERE id = ANY($1)', [notifs.map((n) => n.id)]);

    // 2) void FE test invoices
    const invs: any[] = await m.query(`SELECT i.*, c.full_name FROM invoices i JOIN children c ON c.id = i.child_id WHERE i.invoice_no = ANY($1) ORDER BY i.invoice_no`, [VOID_NOS]);
    const wrongChild = invs.filter((i) => i.full_name !== CHILD);
    if (wrongChild.length) throw new Error(`Refusing: ${wrongChild.map((i) => i.invoice_no).join(', ')} not of ${CHILD}`);
    const admin = (await m.query(`SELECT id FROM users WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1`))[0]?.id ?? null;
    const voids: any[] = [];
    for (const i of invs) {
      if (i.status === 'void') { voids.push({ invoiceNo: i.invoice_no, skipped: 'already void', note: i.note }); continue; }
      const usedCredit = -(await m.query(`SELECT COALESCE(SUM(amount),0)::int AS s FROM invoice_lines WHERE invoice_id = $1 AND kind = 'credit'`, [i.id]))[0].s;
      const entry = { invoiceNo: i.invoice_no, period: i.period, before: { total: i.total_amount, paid: i.paid_amount, status: i.status, note: i.note },
        paidMovedToCredit: i.paid_amount, creditLinesRestored: usedCredit, testCreditCancelled: i.paid_amount };
      voids.push(entry);
      if (!apply) continue;
      // == voidCore: status void + reason, restore credit lines, paid money -> credit (void_refund), audit
      await m.query(`UPDATE invoices SET status = 'void', note = $2, updated_at = now() WHERE id = $1`, [i.id, `[Huỷ] ${REASON}${i.note ? ' | ' + i.note : ''}`]);
      if (usedCredit > 0) await m.query(`INSERT INTO credit_transactions (child_id, amount, type, invoice_id, note, created_by) VALUES ($1,$2,'restored',$3,$4,$5)`,
        [i.child_id, usedCredit, i.id, `Hoàn lại số dư do huỷ hoá đơn ${i.invoice_no}`, admin]);
      if (i.paid_amount > 0) {
        await m.query(`INSERT INTO credit_transactions (child_id, amount, type, invoice_id, note, created_by) VALUES ($1,$2,'void_refund',$3,$4,$5)`,
          [i.child_id, i.paid_amount, i.id, `Tiền đã nộp cho hoá đơn ${i.invoice_no} (đã huỷ) chuyển thành số dư`, admin]);
        // test money is not real: cancel it so it is never applied to a real invoice
        await m.query(`INSERT INTO credit_transactions (child_id, amount, type, invoice_id, note, created_by) VALUES ($1,$2,'adjustment',$3,$4,$5)`,
          [i.child_id, -i.paid_amount, i.id, `${REASON}: huỷ số dư từ phiếu thu thử của hoá đơn ${i.invoice_no}`, admin]);
      }
      // release refunded meal days / clawbacks (as voidCore)
      await m.query(`DELETE FROM meal_refunds WHERE invoice_line_id IN (SELECT id FROM invoice_lines WHERE invoice_id = $1)`, [i.id]);
      await m.query(`UPDATE meal_refunds SET reversed_by_line_id = NULL WHERE reversed_by_line_id IN (SELECT id FROM invoice_lines WHERE invoice_id = $1)`, [i.id]);
      await m.query(`INSERT INTO invoice_audit (invoice_id, action, line_id, old_value, new_value, changed_by) VALUES ($1,'voided',NULL,$2,$3,$4)`,
        [i.id, JSON.stringify(entry.before), JSON.stringify({ status: 'void', reason: REASON, movedToCredit: i.paid_amount, restoredCredit: usedCredit, testCreditCancelled: i.paid_amount, by: 'cleanup-acceptance' }), admin]);
    }
    const invNotifs: any[] = await m.query(`SELECT id, title FROM notifications WHERE type = 'invoice' AND data->>'invoiceId' = ANY($1)`, [invs.map((i) => i.id)]);
    log.steps.voidTestInvoices = { child: CHILD, reason: REASON, invoices: voids, invoiceNotificationsDeleted: invNotifs.length };
    if (apply && invNotifs.length) await m.query('DELETE FROM notifications WHERE id = ANY($1)', [invNotifs.map((n) => n.id)]);

    // 3) waiver note on existing 0đ 100%-discount invoices
    const zero: any[] = await m.query(`
      SELECT i.id, i.invoice_no, i.note FROM invoices i WHERE i.status <> 'void' AND i.total_amount = 0
        AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.kind = 'charge' AND l.amount > 0)
        AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.kind IN ('discount','refund'))
        AND (SELECT COALESCE(SUM(amount),0) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.kind <> 'credit') = 0
        AND COALESCE(i.note,'') NOT LIKE '%${WAIVER}%' ORDER BY i.invoice_no`);
    log.steps.waiverNotes = { count: zero.length, invoices: zero.map((z) => ({ invoiceNo: z.invoice_no, before: z.note, after: z.note ? `${WAIVER} | ${z.note}` : WAIVER })) };
    if (apply) for (const z of zero) await m.query('UPDATE invoices SET note = $2 WHERE id = $1', [z.id, z.note ? `${WAIVER} | ${z.note}` : WAIVER]);
  });
  console.log(JSON.stringify(log, null, 2));
  const dir = path.resolve(process.cwd(), 'logs'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `cleanup-acceptance_${log.mode}_${log.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(f, JSON.stringify(log, null, 2)); console.log('log:', f);
  await dataSource.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
