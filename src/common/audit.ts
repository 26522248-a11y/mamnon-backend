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
