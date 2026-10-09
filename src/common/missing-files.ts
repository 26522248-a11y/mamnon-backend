/**
 * B27: find DB rows whose stored file (photo / receipt) no longer exists in the active storage (files written to the
 * ephemeral Render disk before R2 were wiped on deploy). Used by src/database/null-missing-photos.ts and tests.
 */
import { EntityManager } from 'typeorm';
import { FileStorage } from './storage';
import { keyOf } from './upload';

/**
 * B33: how each feature turns the DB value into the storage key it serves (must mirror the controllers exactly):
 *  - 'url': photo_url / receipt_key hold `/uploads/<file>` or `<file>` → sendImage/sendStored use keyOf() (basename);
 *  - 'key': class photos (`photos/<classId>/<id>-full.jpg`) and announcement images (`announcements/<uuid>.jpg`) store the
 *    full key and sendKey() uses it verbatim – stripping it to the basename made every class photo look missing.
 */
export type KeyStyle = 'url' | 'key';
export const storageKeyFor = (style: KeyStyle, stored: string) => (style === 'url' ? keyOf(stored) : stored);

/** Nullable file columns that can be cleared (the app then shows "no photo" / "no receipt"). */
export const NULLABLE_FILE_COLUMNS = [
  { table: 'children', column: 'photo_url', label: 'Ảnh hồ sơ bé', style: 'url' },
  { table: 'authorized_pickers', column: 'photo_url', label: 'Ảnh người đón hộ', style: 'url' },
  { table: 'pickups', column: 'photo_url', label: 'Ảnh giao bé', style: 'url' },
  { table: 'pickup_requests', column: 'photo_url', label: 'Ảnh yêu cầu đón', style: 'url' },
  { table: 'medicines', column: 'photo_url', label: 'Ảnh dặn thuốc', style: 'url' },
  { table: 'finance_entries', column: 'receipt_key', label: 'Hoá đơn thu chi', style: 'url', also: 'receipt_name' },
] as const;
/** NOT NULL keys: reported only (rows must be deleted / re-uploaded by a person, never auto-nulled). */
export const REPORT_ONLY_COLUMNS = [
  { table: 'announcement_attachments', column: 'file_key', label: 'Ảnh thông báo', style: 'key' },
  { table: 'announcement_attachments', column: 'thumb_key', label: 'Ảnh thông báo (thu nhỏ)', style: 'key', thumb: true },
  { table: 'photos', column: 'full_key', label: 'Ảnh lớp', style: 'key' },
  { table: 'photos', column: 'thumb_key', label: 'Ảnh lớp (thu nhỏ)', style: 'key', thumb: true },
] as const;

/** primary = the file itself (photo / receipt / full-size image); thumbnails are derived copies of a primary, so false. */
export interface MissingRow { table: string; column: string; label: string; id: string; stored: string; key: string; nullable: boolean; primary: boolean }
const isThumb = (c: object) => (c as { thumb?: boolean }).thumb === true;

/** Uses storage.exists() (S3 HeadObject / fs.stat) – never downloads the file (B33: GetObject burned B2 read + byte caps). */
export async function findMissingFiles(m: EntityManager, st: FileStorage): Promise<MissingRow[]> {
  const out: MissingRow[] = [];
  const cols = [...NULLABLE_FILE_COLUMNS.map((c) => ({ ...c, nullable: true })), ...REPORT_ONLY_COLUMNS.map((c) => ({ ...c, nullable: false }))];
  for (const c of cols) {
    const rows: { id: string; v: string }[] = await m.query(`SELECT id::text AS id, ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL ORDER BY id`);
    for (const r of rows) {
      const key = storageKeyFor(c.style, r.v);
      let gone: boolean;
      try { gone = !(await st.exists(key)); } catch (e: any) { if (/invalid storage key/.test(e?.message)) gone = true; else throw e; }
      if (gone) out.push({ table: c.table, column: c.column, label: c.label, id: r.id, stored: r.v, key, nullable: c.nullable, primary: !isThumb(c) });
    }
  }
  return out;
}

/**
 * File references in the DB. Default 'primary': one per stored file a user uploaded (a class photo / announcement image
 * counts ONCE – its thumbnail is excluded), which is what the all-missing guard compares against. 'all' = every column
 * findMissingFiles checks (= number of HEAD requests one run costs).
 */
export async function countFileRefs(m: EntityManager, scope: 'primary' | 'all' = 'primary'): Promise<number> {
  let n = 0;
  for (const c of [...NULLABLE_FILE_COLUMNS, ...REPORT_ONLY_COLUMNS]) if (scope === 'all' || !isThumb(c)) n += Number((await m.query(`SELECT COUNT(*)::int AS n FROM ${c.table} WHERE ${c.column} IS NOT NULL`))[0].n);
  return n;
}

/**
 * --apply refuses when EVERY primary reference is missing (wrong STORAGE_DRIVER/UPLOAD_DIR/S3_*?) unless --force.
 * Counted per primary reference (B33 review): thumbnails are excluded on both sides, so a class photo with full + thumb
 * counts once, and a missing thumbnail alone can never push the count to "all".
 */
export const primaryMissing = (rows: MissingRow[]) => rows.filter((r) => r.primary).length;
/** Both guard numbers from ONE definition (primary references only, thumbnails excluded from total AND missing). */
export async function guardCounts(m: EntityManager, rows: MissingRow[]) { return { total: await countFileRefs(m, 'primary'), missing: primaryMissing(rows) }; }
export function assertNotAllMissing(total: number, missing: number, driver: string, force: boolean) {
  if (total > 0 && missing === total && !force)
    throw new Error(`All ${total} file references are missing in storage driver "${driver}" – wrong STORAGE_DRIVER/UPLOAD_DIR/S3_*? Re-run with --apply --force if this is really intended.`);
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
