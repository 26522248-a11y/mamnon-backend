import { EntityManager } from 'typeorm';
import { recordAudit } from '../common/audit';
import { AuthUser } from '../common/auth';
import { AppError } from '../common/errors';

export const CONSENT_WITHDRAWN = 'CONSENT_WITHDRAWN';

/** 422 PHOTO_CONSENT_MISSING with {children: [{childId, name}]} for the given ids lacking consent (empty → no throw). */
export async function assertConsent(m: { query: EntityManager['query'] }, childIds: string[]) {
  if (!childIds.length) return;
  const missing: { childId: string; name: string }[] = await m.query(
    `SELECT id AS "childId", full_name AS name FROM children WHERE id = ANY($1) AND NOT photo_consent ORDER BY full_name`, [[...new Set(childIds)]]);
  if (missing.length) throw new AppError(422, 'PHOTO_CONSENT_MISSING',
    `Chưa có đồng ý đăng ảnh của phụ huynh: ${missing.map((c) => c.name).join(', ')}`, { children: missing });
}

/**
 * Consent withdrawn for a child: every (non-deleted) photo tagging the child is hidden – not deleted.
 * Already-hidden photos get the child appended to hidden_for_child_ids (sticky). One audit event per photo.
 * Returns affected photos (id, classId).
 */
export async function hidePhotosOfChild(m: EntityManager, u: AuthUser, childId: string, ip?: string) {
  const rows: { id: string; class_id: string; hidden: boolean; hidden_reason: string | null; hidden_for_child_ids: string[] }[] = await m.query(`
    SELECT p.id, p.class_id, p.hidden, p.hidden_reason, p.hidden_for_child_ids FROM photos p JOIN photo_tags t ON t.photo_id = p.id
    WHERE t.child_id = $1 AND p.deleted_at IS NULL FOR UPDATE OF p`, [childId]);
  for (const r of rows) {
    const forIds = r.hidden_for_child_ids.includes(childId) ? r.hidden_for_child_ids : [...r.hidden_for_child_ids, childId];
    await m.query(`UPDATE photos SET hidden = true, hidden_reason = COALESCE(hidden_reason, $2), hidden_for_child_ids = $3,
      hidden_at = COALESCE(hidden_at, now()) WHERE id = $1`, [r.id, CONSENT_WITHDRAWN, forIds]);
    await recordAudit(m, u, { action: 'photo.auto_hide', entityType: 'photo', entityId: r.id, childId,
      before: { hidden: r.hidden, hiddenReason: r.hidden_reason, hiddenForChildIds: r.hidden_for_child_ids },
      after: { hidden: true, hiddenReason: r.hidden_reason ?? CONSENT_WITHDRAWN, hiddenForChildIds: forIds }, reason: CONSENT_WITHDRAWN, ip, data: { classId: r.class_id } });
  }
  return rows.map((r) => ({ id: r.id, classId: r.class_id }));
}
