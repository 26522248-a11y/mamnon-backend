/**
 * Backfill `audit_events` from (1) logs/audit.jsonl (entries written before the table existed; entries marked
 * `persisted: true` are already in the DB and skipped) and (2) sensitive_access_logs (full-CCCD views) that have no
 * matching `pickup.identity_view` event. Idempotent (dedupe_key). Dry run by default; `-- --apply` writes.
 *   npm run backfill:audit [-- --file=/path/audit.jsonl] [-- --apply]
 * File default: $AUDIT_LOG_DIR/audit.jsonl or ./logs/audit.jsonl. Log -> logs/backfill-audit_<mode>_<ts>.json.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import dataSource from './data-source';

type Row = { dedupeKey: string; source: string; createdAt: string; actorId: string | null; actorUsername: string | null; action: string; entityType: string;
  entityId: string | null; childId: string | null; before: unknown; after: unknown; reason: string | null; ip: string | null; data: unknown };

const pick = (o: any, ...keys: string[]) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null) return o[k]; return null; };

/** Map one jsonl entry (old or new format) to an audit_events row. */
export function mapJsonl(e: any, line: string): Row {
  const { at, action, actorId, actorUsername, persisted, entityType, entityId, childId, before, after, reason, ip, ...rest } = e;
  const base = { dedupeKey: 'jsonl:' + crypto.createHash('sha256').update(line).digest('hex').slice(0, 64), source: 'backfill_jsonl', createdAt: at,
    actorId: actorId ?? null, actorUsername: actorUsername ?? null, action };
  if (entityType) return { ...base, entityType, entityId: entityId ?? null, childId: childId ?? null, before: before ?? null, after: after ?? null, reason: reason ?? null, ip: ip ?? null,
    data: Object.keys(rest).length ? rest : null };
  if (action === 'guardian.remove') {
    const { removed, account, ...more } = rest;
    return { ...base, entityType: 'guardian', entityId: removed?.guardianId ?? null, childId: removed?.childId ?? null, before: removed ?? null, after: null,
      reason: reason ?? null, ip: ip ?? null, data: { account: account ?? null, ...more } };
  }
  // early pickup-safety lines: { pickerId | dutyId | pickupRequestId | entityId, childId, … }
  const type = action.split('.')[0] === 'pickup' ? (rest.kind ?? 'pickup') : action.split('.')[0];
  return { ...base, entityType: type, entityId: pick(rest, 'pickerId', 'dutyId', 'pickupRequestId', 'userId'), childId: childId ?? null,
    before: before ?? null, after: after ?? null, reason: reason ?? pick(rest, 'note'), ip: ip ?? null, data: Object.keys(rest).length ? rest : null };
}

if (require.main === module) (async () => {
  const apply = process.argv.includes('--apply');
  const fileArg = process.argv.find((a) => a.startsWith('--file='))?.slice(7);
  const file = fileArg || path.join(process.env.AUDIT_LOG_DIR || path.join(process.cwd(), 'logs'), 'audit.jsonl');
  await dataSource.initialize();
  const log: any = { at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', file, jsonl: { lines: 0, skippedPersisted: 0, invalid: 0, candidates: 0 }, sensitive: { candidates: 0 }, inserted: 0, items: [] };
  const rows: Row[] = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
      log.jsonl.lines++;
      let e: any;
      try { e = JSON.parse(line); } catch { log.jsonl.invalid++; continue; }
      if (!e?.action || !e?.at) { log.jsonl.invalid++; continue; }
      if (e.persisted) { log.jsonl.skippedPersisted++; continue; }
      rows.push(mapJsonl(e, line));
    }
  } else log.jsonl.missing = true;
  log.jsonl.candidates = rows.length;
  const sal: any[] = await dataSource.query(`
    SELECT s.* FROM sensitive_access_logs s
    WHERE NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.action = 'pickup.identity_view' AND e.actor_id = s.user_id AND e.entity_id = s.entity_id::text
                        AND abs(extract(epoch FROM e.created_at - s.created_at)) < 10)`);
  for (const s of sal) rows.push({ dedupeKey: 'sal:' + s.id, source: 'backfill_sensitive_log', createdAt: new Date(s.created_at).toISOString(), actorId: s.user_id, actorUsername: null,
    action: 'pickup.identity_view', entityType: s.entity_type, entityId: s.entity_id, childId: s.child_id, before: null, after: null, reason: null, ip: s.ip,
    data: { field: s.field, purpose: s.purpose, attendanceId: s.attendance_id } });
  log.sensitive.candidates = sal.length;
  await dataSource.transaction(async (m) => {
    for (const r of rows) {
      const [u] = r.actorId ? await m.query('SELECT username, role FROM users WHERE id = $1', [r.actorId]) : [];
      const exists = (await m.query('SELECT 1 FROM audit_events WHERE dedupe_key = $1', [r.dedupeKey])).length > 0;
      log.items.push({ dedupeKey: r.dedupeKey, action: r.action, at: r.createdAt, entityType: r.entityType, entityId: r.entityId, childId: r.childId, alreadyImported: exists });
      if (!apply || exists) continue;
      const j = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
      const res = await m.query(`INSERT INTO audit_events (actor_id, actor_username, actor_role, action, entity_type, entity_id, child_id, before, after, reason, ip, data, source, dedupe_key, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [r.actorId, r.actorUsername ?? u?.username ?? null, u?.role ?? null, r.action, r.entityType, r.entityId, r.childId, j(r.before), j(r.after), r.reason, r.ip, j(r.data), r.source, r.dedupeKey, r.createdAt]);
      log.inserted += res.length;
    }
  });
  const dir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `backfill-audit_${log.mode}_${log.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(JSON.stringify({ mode: log.mode, file, jsonl: log.jsonl, sensitive: log.sensitive, inserted: log.inserted, log: out }));
  await dataSource.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
