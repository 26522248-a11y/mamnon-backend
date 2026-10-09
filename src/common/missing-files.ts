/**
 * B27: find DB rows whose stored file (photo / receipt) no longer exists in the active storage (files written to the
 * ephemeral Render disk before R2 were wiped on deploy). Used by src/database/null-missing-photos.ts and tests.
 */
import { EntityManager } from 'typeorm';
import { FileStorage } from './storage';
import { keyOf } from './upload';

/** Nullable file columns that can be cleared (the app then shows "no photo" / "no receipt"). */
export const NULLABLE_FILE_COLUMNS = [
  { table: 'children', column: 'photo_url', label: 'Ảnh hồ sơ bé' },
  { table: 'authorized_pickers', column: 'photo_url', label: 'Ảnh người đón hộ' },
  { table: 'pickups', column: 'photo_url', label: 'Ảnh giao bé' },
  { table: 'pickup_requests', column: 'photo_url', label: 'Ảnh yêu cầu đón' },
  { table: 'medicines', column: 'photo_url', label: 'Ảnh dặn thuốc' },
  { table: 'finance_entries', column: 'receipt_key', label: 'Hoá đơn thu chi', also: 'receipt_name' },
] as const;
/** NOT NULL keys: reported only (rows must be deleted / re-uploaded by a person, never auto-nulled). */
export const REPORT_ONLY_COLUMNS = [
  { table: 'announcement_attachments', column: 'file_key', label: 'Ảnh thông báo' },
  { table: 'photos', column: 'full_key', label: 'Ảnh lớp' },
] as const;

export interface MissingRow { table: string; column: string; label: string; id: string; stored: string; nullable: boolean }

export async function findMissingFiles(m: EntityManager, st: FileStorage): Promise<MissingRow[]> {
  const out: MissingRow[] = [];
  const cols = [...NULLABLE_FILE_COLUMNS.map((c) => ({ ...c, nullable: true })), ...REPORT_ONLY_COLUMNS.map((c) => ({ ...c, nullable: false }))];
  for (const c of cols) {
    const rows: { id: string; v: string }[] = await m.query(`SELECT id::text AS id, ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL ORDER BY id`);
    for (const r of rows) {
      let gone: boolean;
      try { gone = !(await st.get(keyOf(r.v))); } catch (e: any) { if (/invalid storage key/.test(e?.message)) gone = true; else throw e; }
      if (gone) out.push({ table: c.table, column: c.column, label: c.label, id: r.id, stored: r.v, nullable: c.nullable });
    }
  }
  return out;
}

/** Total file references (all tables above) – lets the CLI refuse to wipe everything when pointed at the wrong storage. */
export async function countFileRefs(m: EntityManager): Promise<number> {
  let n = 0;
  for (const c of [...NULLABLE_FILE_COLUMNS, ...REPORT_ONLY_COLUMNS]) n += Number((await m.query(`SELECT COUNT(*)::int AS n FROM ${c.table} WHERE ${c.column} IS NOT NULL`))[0].n);
  return n;
}

/** Clears only rows that still point at the same missing value (safe if a new photo was uploaded meanwhile). */
export async function nullMissingFiles(m: EntityManager, rows: MissingRow[]): Promise<number> {
  let n = 0;
  for (const r of rows.filter((x) => x.nullable)) {
    const also = NULLABLE_FILE_COLUMNS.find((c) => c.table === r.table && c.column === r.column) as { also?: string } | undefined;
    const res = await m.query(`UPDATE ${r.table} SET ${r.column} = NULL${also?.also ? `, ${also.also} = NULL` : ''} WHERE id = $1 AND ${r.column} = $2`, [r.id, r.stored]);
    n += Array.isArray(res) ? Number(res[1] ?? 0) : 0;
  }
  return n;
}
