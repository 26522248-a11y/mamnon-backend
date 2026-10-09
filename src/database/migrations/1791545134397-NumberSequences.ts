import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sequences for human-readable invoice numbers (HD202610-00001) and receipt numbers (PT202610-00001). */
export class NumberSequences1791545134397 implements MigrationInterface {
  name = 'NumberSequences1791545134397';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE SEQUENCE IF NOT EXISTS invoice_no_seq`);
    await q.query(`CREATE SEQUENCE IF NOT EXISTS receipt_no_seq`);
    await q.query(`ALTER TABLE "invoices" ADD CONSTRAINT "ck_invoice_amounts" CHECK (total_amount >= 0 AND paid_amount >= 0 AND paid_amount <= total_amount)`);
    await q.query(`ALTER TABLE "payments" ADD CONSTRAINT "ck_payment_amount" CHECK (amount > 0)`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "payments" DROP CONSTRAINT "ck_payment_amount"`);
    await q.query(`ALTER TABLE "invoices" DROP CONSTRAINT "ck_invoice_amounts"`);
    await q.query(`DROP SEQUENCE IF EXISTS receipt_no_seq`);
    await q.query(`DROP SEQUENCE IF EXISTS invoice_no_seq`);
  }
}
