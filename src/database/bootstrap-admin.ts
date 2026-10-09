/**
 * Production first-run: creates ONLY the first admin account (no demo data, no 123456 accounts).
 *   INITIAL_ADMIN_USERNAME=hieutruong INITIAL_ADMIN_PASSWORD='...' npm run bootstrap:admin
 *   (or: npm run bootstrap:admin -- --username hieutruong --password '...' [--name 'Cô Hiệu trưởng'])
 * - Idempotent: if any admin already exists it does nothing (exit 0).
 * - Refuses weak passwords (< 10 chars, no letter+digit mix, common/123456, equal to username).
 * - The account gets mustChangePassword=true, so the first login must set a new password.
 */
import * as bcrypt from 'bcryptjs';
import dataSource from './data-source';
import { User } from './entities';

const WEAK = new Set(['123456', '1234567', '12345678', '123456789', '1234567890', '123456a', 'password', 'password1', 'matkhau', 'admin', 'admin123', 'admin@123', 'qwerty', 'abc123', '111111', '000000', 'mamnon', 'mamnon123']);

export function passwordProblem(username: string, pw: string): string | null {
  if (!pw) return 'missing password';
  if (pw.length < 10) return 'password must be at least 10 characters';
  if (WEAK.has(pw.toLowerCase()) || /^(\d)\1+$/.test(pw) || /^(0123456789|123456)/.test(pw)) return 'password is too common';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'password must contain letters and digits';
  if (pw.toLowerCase().includes(username.toLowerCase())) return 'password must not contain the username';
  return null;
}

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };

if (require.main === module) {
  (async () => {
    const username = (arg('username') ?? process.env.INITIAL_ADMIN_USERNAME ?? '').trim().toLowerCase();
    const password = arg('password') ?? process.env.INITIAL_ADMIN_PASSWORD ?? '';
    const name = (arg('name') ?? process.env.INITIAL_ADMIN_NAME ?? 'Quản trị viên').trim();
    await dataSource.initialize();
    const [{ n }] = await dataSource.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`);
    if (n > 0) { console.log(`bootstrap:admin: ${n} admin account(s) already exist – nothing to do.`); await dataSource.destroy(); return; }
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new Error('Set INITIAL_ADMIN_USERNAME (3-64 chars: a-z 0-9 . _ -)');
    const bad = passwordProblem(username, password);
    if (bad) throw new Error(`INITIAL_ADMIN_PASSWORD refused: ${bad}`);
    await dataSource.getRepository(User).save({ username, name, role: 'admin', passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true, isActive: true });
    console.log(`bootstrap:admin: created admin "${username}" (must change password at first login). Remove INITIAL_ADMIN_PASSWORD from the env now.`);
    await dataSource.destroy();
  })().catch(async (e) => { console.error(`bootstrap:admin failed: ${e.message ?? e}`); process.exit(1); });
}
