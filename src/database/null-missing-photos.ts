/**
 * B27 one-off: list (and optionally clear) photo / receipt references whose file is missing in the ACTIVE storage
 * (STORAGE_DRIVER + UPLOAD_DIR or S3_*). Dry run by default; `-- --apply` sets the nullable columns to NULL.
 * Announcement images and class photos (NOT NULL keys) are only reported. Log -> $AUDIT_LOG_DIR or logs/.
 *   npm run repair:missing-photos              # dry run
 *   npm run repair:missing-photos -- --apply   # clear
 * Take a pg_dump first. Run it with the SAME storage env as the API, otherwise every file looks missing – as a guard,
 * --apply refuses when EVERY reference is missing unless --force is also given.
 * B33: existence is checked with HeadObject / stat on the exact key each feature serves (class photos keep their
 * `photos/<classId>/…` prefix); no file is downloaded.
 */
import * as fs from 'fs';
import * as path from 'path';
import dataSource from './data-source';
import { assertNotAllMissing, countFileRefs, findMissingFiles, guardCounts, nullMissingFiles } from '../common/missing-files';
import { storage } from '../common/storage';

(async () => {
  const apply = process.argv.includes('--apply');
  await dataSource.initialize();
  const st = storage();
  const missing = await findMissingFiles(dataSource.manager, st);
  const byTable: Record<string, number> = {};
  for (const r of missing) byTable[`${r.table}.${r.column}`] = (byTable[`${r.table}.${r.column}`] ?? 0) + 1;
  const g = await guardCounts(dataSource.manager, missing); // total + missing both per primary reference (thumbnails excluded)
  const total = g.total;
  if (apply) assertNotAllMissing(g.total, g.missing, st.driver, process.argv.includes('--force'));
  const cleared = apply ? await dataSource.transaction((m) => nullMissingFiles(m, missing)) : 0;
  const log = { at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', driver: st.driver, total, missingPrimary: g.missing, checked: await countFileRefs(dataSource.manager, 'all'), missing: missing.length, byTable, cleared, items: missing };
  const dir = process.env.AUDIT_LOG_DIR || path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `null-missing-photos-${log.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(f, JSON.stringify(log, null, 2));
  console.log(JSON.stringify({ ...log, items: undefined }, null, 2));
  console.log(apply ? `cleared ${cleared} rows` : 'dry run – nothing changed (add -- --apply to clear)', '· log:', f);
  await dataSource.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
