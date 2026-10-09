process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://mamnon:mamnon@localhost:5432/mamnon_test';
process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';
process.env.AUDIT_LOG_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mamnon-audit-'));
// Production-like cross-site setup: web on Vercel, API on Render
process.env.CORS_ORIGIN = 'https://mamnon.vercel.app, https://mamnon-*-team.vercel.app';
process.env.COOKIE_SAMESITE = 'none';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { spawnSync } from 'child_process';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule, configureApp } from '../src/app.module';
import { corsOriginList, databaseSsl, isAllowedOrigin, refreshCookieOptions, stripSslMode } from '../src/common/deploy-config';
import { seed } from '../src/database/seed';

describe('Deployment config (Vercel + Render + Neon)', () => {
  it('CORS list: exact origins, trailing slash, wildcard previews', () => {
    const l = corsOriginList('https://a.vercel.app/, https://mamnon-*-team.vercel.app,http://localhost:3000');
    expect(isAllowedOrigin('https://a.vercel.app', l)).toBe(true);
    expect(isAllowedOrigin('https://mamnon-git-main-team.vercel.app', l)).toBe(true);
    expect(isAllowedOrigin('https://mamnon-x.y-team.vercel.app', l)).toBe(false); // * = one label part, no dots
    expect(isAllowedOrigin('https://evil.com', l)).toBe(false);
    expect(isAllowedOrigin('https://mamnon-x-team.vercel.app.evil.com', l)).toBe(false);
    expect(isAllowedOrigin(undefined, l)).toBe(true);
  });

  it('refresh cookie: lax by default, SameSite=None forces Secure', () => {
    const keep = { s: process.env.COOKIE_SAMESITE, c: process.env.COOKIE_SECURE };
    process.env.COOKIE_SAMESITE = ''; process.env.COOKIE_SECURE = '';
    expect(refreshCookieOptions()).toMatchObject({ sameSite: 'lax', secure: false, httpOnly: true, path: '/api/v1/auth' });
    process.env.COOKIE_SECURE = 'true';
    expect(refreshCookieOptions()).toMatchObject({ sameSite: 'lax', secure: true });
    process.env.COOKIE_SAMESITE = 'none'; process.env.COOKIE_SECURE = 'false';
    expect(refreshCookieOptions()).toMatchObject({ sameSite: 'none', secure: true });
    process.env.COOKIE_SAMESITE = keep.s; process.env.COOKIE_SECURE = keep.c;
  });

  it('Postgres TLS from sslmode (Neon) / DATABASE_SSL', () => {
    const neon = 'postgresql://u:p%40ss@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    expect(databaseSsl(neon, undefined)).toEqual({ rejectUnauthorized: true });
    expect(stripSslMode(neon)).toBe('postgresql://u:p%40ss@ep-x-pooler.ap-southeast-1.aws.neon.tech/neondb');
    expect(stripSslMode('postgres://a:b@h:5432/db?sslmode=require&application_name=x')).toBe('postgres://a:b@h:5432/db?application_name=x');
    expect(databaseSsl('postgres://mamnon:mamnon@localhost:5432/mamnon', undefined)).toBe(false);
    expect(databaseSsl('postgres://h/db', 'true')).toEqual({ rejectUnauthorized: true });
    expect(databaseSsl('postgres://h/db', 'no-verify')).toEqual({ rejectUnauthorized: false });
    expect(databaseSsl(neon, 'false')).toBe(false);
  });

  it('demo seed refuses in production (function and CLI)', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await expect(seed({} as DataSource)).rejects.toThrow(/disabled in production/);
    process.env.NODE_ENV = env;
    const r = spawnSync('npx', ['ts-node', '--transpile-only', 'src/database/seed.ts'], { env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Refusing to run the DEMO seed/);
  }, 70000);

  describe('cross-site login + refresh (web on another domain)', () => {
    let app: NestExpressApplication, http: any;
    beforeAll(async () => {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = configureApp(mod.createNestApplication<NestExpressApplication>());
      await app.init();
      http = app.getHttpServer();
      const ds = app.get(DataSource);
      await ds.runMigrations();
      await seed(ds);
    });
    afterAll(async () => { await app?.close(); });

    it('allowed preview origin gets CORS + SameSite=None; Secure cookie, and refresh works with it', async () => {
      const origin = 'https://mamnon-git-feature-team.vercel.app';
      const pre = await request(http).options('/api/v1/auth/login').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
      expect(pre.headers['access-control-allow-credentials']).toBe('true');
      const r = await request(http).post('/api/v1/auth/login').set('Origin', origin).send({ username: 'admin', password: '123456' }).expect(200);
      expect(r.headers['access-control-allow-origin']).toBe(origin);
      const cookie = ([] as string[]).concat(r.headers['set-cookie'] as any).find((c) => c.startsWith('refresh_token='))!;
      expect(cookie).toMatch(/SameSite=None/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      const ref = await request(http).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', cookie.split(';')[0]).expect(200);
      expect(ref.body.accessToken).toEqual(expect.any(String));
      const out = await request(http).post('/api/v1/auth/logout').set('Origin', origin).set('Cookie', cookie.split(';')[0]).set('Authorization', `Bearer ${ref.body.accessToken}`);
      expect(out.status).toBeLessThan(300);
      const cleared = ([] as string[]).concat(out.headers['set-cookie'] as any).filter(Boolean).find((c) => c.startsWith('refresh_token='));
      expect(cleared).toMatch(/SameSite=None/);
    });

    it('unknown origin gets no CORS headers', async () => {
      const r = await request(http).post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ username: 'admin', password: '123456' });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
