import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { databaseSsl, stripSslMode } from '../common/deploy-config';
import { ENTITIES } from './entities';

// Minimal .env loader (no extra dependency) so CLI/seed and app share config.
export function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv();

const DB_URL = process.env.DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon';
const DB_SSL = databaseSsl(DB_URL);

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: DB_SSL ? stripSslMode(DB_URL) : DB_URL,
  ssl: DB_SSL,
  entities: ENTITIES,
  migrations: [path.join(__dirname, 'migrations', '*.{ts,js}')],
  synchronize: false,
  logging: false,
};

export default new DataSource(dataSourceOptions);
