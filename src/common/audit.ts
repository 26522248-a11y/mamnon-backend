import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const logger = new Logger('Audit');

/**
 * Append-only audit trail (JSON lines) for sensitive admin actions that have no audit table yet.
 * File: $AUDIT_LOG_DIR/audit.jsonl (default ./logs/audit.jsonl, relative to the API working directory). Also echoed to stdout.
 * Written synchronously so the entry exists before the response is sent.
 */
export function audit(action: string, actor: { id: string; username: string }, data: Record<string, unknown>) {
  const entry = { at: new Date().toISOString(), action, actorId: actor.id, actorUsername: actor.username, ...data };
  const line = JSON.stringify(entry);
  logger.log(line);
  try {
    const dir = process.env.AUDIT_LOG_DIR || path.join(process.cwd(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), line + '\n');
  } catch (e) {
    logger.error(`audit write failed: ${(e as Error).message}`);
  }
  return entry;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  childId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  ip?: string | null;
  data?: Record<string, unknown> | null;
  /** readable target snapshot; default = child's name + class when childId is set */
  targetLabel?: string | null;
}
type Actor = { id: string; username: string; role?: string; name?: string };

/**
 * Persist an audit event in `audit_events` (primary; pass the transaction's EntityManager so it commits/rolls back with
 * the change) and append it to logs/audit.jsonl (secondary). A DB failure propagates (the action must not happen unaudited).
 */
export async function recordAudit(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, actor: Actor, ev: AuditInput) {
  const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  await db.query(
    `INSERT INTO audit_events (actor_id, actor_username, actor_role, action, entity_type, entity_id, child_id, before, after, reason, ip, data, source,
       actor_name, target_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10,$11,$12,'api',
       COALESCE($13::varchar, (SELECT name FROM users WHERE id = $1::uuid)),
       LEFT(COALESCE($14::varchar, (SELECT c.full_name || COALESCE(' · ' || cl.name, '') FROM children c LEFT JOIN classes cl ON cl.id = c.class_id WHERE c.id = $7::uuid)), 200))`,
    [actor.id, actor.username, actor.role ?? null, ev.action, ev.entityType, ev.entityId ?? null, ev.childId ?? null, j(ev.before), j(ev.after),
      ev.reason ?? null, ev.ip?.slice(0, 64) ?? null, j(ev.data), actor.name ?? null, ev.targetLabel ?? null]);
  return audit(ev.action, actor, { persisted: true, entityType: ev.entityType, entityId: ev.entityId ?? null, childId: ev.childId ?? null,
    ...(ev.before ? { before: ev.before } : {}), ...(ev.after ? { after: ev.after } : {}), ...(ev.reason ? { reason: ev.reason } : {}),
    ...(ev.ip ? { ip: ev.ip } : {}), ...(ev.data ?? {}) });
}
