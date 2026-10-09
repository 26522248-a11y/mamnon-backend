/** npm run import:template -> deploy/templates/mau-nhap-hoc-sinh.xlsx (same file as GET /imports/children/template). */
import * as fs from 'fs';
import * as path from 'path';
import { buildTemplate } from './children-import';

(async () => {
  const out = path.resolve(__dirname, '..', '..', 'deploy', 'templates', 'mau-nhap-hoc-sinh.xlsx');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await buildTemplate());
  console.log(out);
})().catch((e) => { console.error(e); process.exit(1); });
