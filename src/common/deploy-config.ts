/**
 * Deployment knobs read from env (Render / Docker / dev):
 *  - CORS_ORIGIN: comma list of allowed web origins; an entry may contain "*" for one DNS label,
 *    e.g. "https://mamnon-web.vercel.app,https://mamnon-*-team.vercel.app" (Vercel preview deployments).
 *  - COOKIE_SECURE=true|false, COOKIE_SAMESITE=lax|strict|none (none = web and API on different sites; forces Secure).
 *  - DATABASE_URL with ?sslmode=require (Neon) or DATABASE_SSL=true → TLS to Postgres.
 */
import type { CookieOptions } from 'express';

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');

export function corsOriginList(raw = process.env.CORS_ORIGIN || 'http://localhost:3000'): (string | RegExp)[] {
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
    .map((o) => (o.includes('*') ? new RegExp('^' + o.split('*').map(escape).join('[a-z0-9-]+') + '$', 'i') : o));
}

export function isAllowedOrigin(origin: string | undefined, list = corsOriginList()): boolean {
  if (!origin) return true; // same-origin / server-to-server / curl
  return list.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));
}

export function refreshCookieOptions(): CookieOptions {
  const raw = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  const sameSite: 'lax' | 'strict' | 'none' = raw === 'none' || raw === 'strict' ? raw : 'lax';
  const secure = sameSite === 'none' || process.env.COOKIE_SECURE === 'true';
  return { httpOnly: true, sameSite, secure, path: '/api/v1/auth' };
}

/** TLS for Postgres: Neon/Render URLs carry sslmode=require. DATABASE_SSL=false forces it off; =no-verify skips cert check. */
export function databaseSsl(url = process.env.DATABASE_URL || '', flag = process.env.DATABASE_SSL): false | { rejectUnauthorized: boolean } {
  const f = (flag || '').toLowerCase();
  if (f === 'false' || f === '0' || f === 'disable') return false;
  if (f === 'no-verify') return { rejectUnauthorized: false };
  const mode = /[?&]sslmode=([^&]+)/.exec(url)?.[1]?.toLowerCase();
  if (f === 'true' || f === '1' || (mode && mode !== 'disable' && mode !== 'allow' && mode !== 'prefer')) return { rejectUnauthorized: mode !== 'no-verify' };
  return false;
}

/** pg would let sslmode in the URL override our `ssl` object – strip it (and channel_binding) once handled here. */
export function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
    return u.toString();
  } catch { return url; }
}
