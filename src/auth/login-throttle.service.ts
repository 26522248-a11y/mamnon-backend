import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors';

interface Bucket { fails: number; first: number; lockedUntil: number }

/**
 * Failed-login limiter (in memory, single instance):
 *  - per username+IP: LOGIN_MAX_FAILS (5) failures within the window -> locked LOGIN_LOCK_MINUTES (15)
 *  - per IP: LOGIN_IP_MAX_FAILS (30) failures within the window -> locked
 * While locked even a correct password gets 429. Successful login clears the username+IP bucket.
 * NOTE: multi-instance deployments need a shared store (Redis/DB).
 */
@Injectable()
export class LoginThrottleService {
  private buckets = new Map<string, Bucket>();
  private get maxUser() { return Number(process.env.LOGIN_MAX_FAILS || 5); }
  private get maxIp() { return Number(process.env.LOGIN_IP_MAX_FAILS || 30); }
  private get windowMs() { return Number(process.env.LOGIN_LOCK_MINUTES || 15) * 60_000; }

  private keys(username: string, ip: string) { return { user: `u:${username.toLowerCase()}|${ip}`, ip: `ip:${ip}` }; }

  private live(key: string, now: number) {
    const b = this.buckets.get(key);
    if (b && b.lockedUntil <= now && now - b.first > this.windowMs) { this.buckets.delete(key); return undefined; }
    return b;
  }

  /** Throws 429 if this username+IP or this IP is currently locked. */
  assertAllowed(username: string, ip: string) {
    const now = Date.now(), k = this.keys(username, ip);
    const locked = [this.live(k.user, now), this.live(k.ip, now)].filter((b) => b && b.lockedUntil > now) as Bucket[];
    if (locked.length) {
      const until = Math.max(...locked.map((b) => b.lockedUntil));
      const retry = Math.ceil((until - now) / 1000);
      const e = new AppError(429, 'TOO_MANY_ATTEMPTS', `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(retry / 60)} phút`, undefined,
        { lockedUntil: new Date(until).toISOString(), retryAfterSeconds: retry, lockScope: locked.some((b) => b === this.live(k.user, now)) ? 'account' : 'ip' });
      (e as any).retryAfter = retry;
      throw e;
    }
  }

  recordFailure(username: string, ip: string) {
    const now = Date.now(), k = this.keys(username, ip);
    for (const [key, max] of [[k.user, this.maxUser], [k.ip, this.maxIp]] as const) {
      const b = this.live(key, now) ?? { fails: 0, first: now, lockedUntil: 0 };
      b.fails += 1;
      if (b.fails >= max) b.lockedUntil = now + this.windowMs;
      this.buckets.set(key, b);
    }
    if (this.buckets.size > 50_000) for (const [key] of this.buckets) { if (!this.live(key, now)) this.buckets.delete(key); }
  }

  recordSuccess(username: string, ip: string) { this.buckets.delete(this.keys(username, ip).user); }

  /** Latest lock end for this username across all IPs (null if not locked). */
  lockedUntil(username: string): Date | null {
    const now = Date.now(), prefix = `u:${username.toLowerCase()}|`;
    let max = 0;
    for (const [key, b] of this.buckets) if (key.startsWith(prefix) && b.lockedUntil > now) max = Math.max(max, b.lockedUntil);
    return max ? new Date(max) : null;
  }

  /** Admin password reset / unlock: clear all username buckets. */
  clearUser(username: string) {
    const prefix = `u:${username.toLowerCase()}|`;
    for (const key of [...this.buckets.keys()]) if (key.startsWith(prefix)) this.buckets.delete(key);
  }
}
