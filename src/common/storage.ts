/**
 * File storage abstraction.
 *  - STORAGE_DRIVER=local (default): files in UPLOAD_DIR (Render persistent disk /var/data/uploads, Docker volume…).
 *  - STORAGE_DRIVER=s3: any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) –
 *    S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET, optional S3_REGION (default "auto"), S3_PUBLIC_BASE.
 * B27: EVERY upload (child/picker/pickup/medicine photos, receipts, avatars, announcement + class photos) goes through storage().
 * Files are always streamed through permission-checked API endpoints (children's photos stay private); S3_PUBLIC_BASE is only
 * reported by publicUrl() for non-sensitive assets and is never used for announcement images.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Local driver dir (NOT served statically). Resolved lazily so tests / scripts can set UPLOAD_DIR first. */
export const uploadDir = () => process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');

export interface FileStorage {
  readonly driver: 'local' | 's3';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  /** Keys starting with `prefix` (flat keys only; used by seed cleanup / maintenance scripts). */
  list(prefix: string): Promise<string[]>;
  publicUrl(key: string): string | null;
}

const safeKey = (key: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,200}$/.test(key) || key.includes('..')) throw new Error(`invalid storage key: ${key}`);
  return key;
};

export class LocalStorage implements FileStorage {
  readonly driver = 'local' as const;
  constructor(private fixedDir?: string) {}
  private get dir() { return this.fixedDir ?? uploadDir(); }
  private file(key: string) { return path.join(this.dir, safeKey(key)); }
  async put(key: string, data: Buffer) { const f = this.file(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); }
  async get(key: string) { const f = this.file(key); return fs.existsSync(f) ? fs.readFileSync(f) : null; }
  async remove(key: string) { fs.rmSync(this.file(key), { force: true }); }
  async list(prefix: string) { return fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => f.startsWith(prefix)) : []; }
  publicUrl() { return null; }
}

/** Minimal surface of @aws-sdk/client-s3 used here (lets tests inject a fake). */
export interface S3Like { send(cmd: any): Promise<any> }

export class S3Storage implements FileStorage {
  readonly driver = 's3' as const;
  private sdk = require('@aws-sdk/client-s3');
  constructor(private bucket: string, private client: S3Like, private publicBase: string | null = null) {}
  static fromEnv(env = process.env): S3Storage {
    const miss = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET'].filter((k) => !env[k]);
    if (miss.length) throw new Error(`STORAGE_DRIVER=s3 needs ${miss.join(', ')}`);
    const { S3Client } = require('@aws-sdk/client-s3');
    const client = new S3Client({ region: env.S3_REGION || 'auto', endpoint: env.S3_ENDPOINT, forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
      credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET! } });
    return new S3Storage(env.S3_BUCKET!, client, env.S3_PUBLIC_BASE || null);
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    try {
      const r = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
      const b = r.Body;
      if (!b) return null;
      if (Buffer.isBuffer(b)) return b;
      if (typeof b.transformToByteArray === 'function') return Buffer.from(await b.transformToByteArray());
      const chunks: Buffer[] = []; for await (const c of b) chunks.push(Buffer.from(c)); return Buffer.concat(chunks);
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async remove(key: string) { await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })); }
  async list(prefix: string) {
    const out: string[] = []; let token: string | undefined;
    do {
      const r = await this.client.send(new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r?.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r?.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  publicUrl(key: string) { return this.publicBase ? `${this.publicBase.replace(/\/+$/, '')}/${safeKey(key)}` : null; }
}

/**
 * B31: small in-process LRU for hot objects in front of a remote bucket (B2 free tier: 2,500 GetObject + 1 GB/day).
 * Bounded by total bytes (default 48 MB, STORAGE_CACHE_MB; 0 = off) and per-object size (2 MB) – fits Render Free 512 MB.
 * Writes/deletes through this process keep it coherent; keys written by the app are per-upload UUIDs anyway.
 */
export class CachedStorage implements FileStorage {
  readonly driver: FileStorage['driver'];
  private map = new Map<string, Buffer>();
  private bytes = 0;
  stats = { hits: 0, misses: 0 };
  constructor(private inner: FileStorage, private maxBytes = 48 * 1024 * 1024, private maxItem = 2 * 1024 * 1024) { this.driver = inner.driver; }
  get size() { return { items: this.map.size, bytes: this.bytes }; }
  private drop(key: string) { const b = this.map.get(key); if (b) { this.bytes -= b.length; this.map.delete(key); } }
  private add(key: string, b: Buffer) {
    this.drop(key);
    if (b.length > this.maxItem || b.length > this.maxBytes) return;
    this.map.set(key, b); this.bytes += b.length;
    for (const k of this.map.keys()) { if (this.bytes <= this.maxBytes) break; this.drop(k); } // oldest first
  }
  async get(key: string) {
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); this.stats.hits++; return hit; }
    this.stats.misses++;
    const b = await this.inner.get(key);
    if (b) this.add(key, b);
    return b;
  }
  async put(key: string, data: Buffer, contentType: string) { this.drop(key); await this.inner.put(key, data, contentType); this.add(key, data); }
  async remove(key: string) { this.drop(key); await this.inner.remove(key); }
  list(prefix: string) { return this.inner.list(prefix); }
  publicUrl(key: string) { return this.inner.publicUrl(key); }
}

let current: FileStorage | null = null;
export function storage(): FileStorage {
  if (current) return current;
  if ((process.env.STORAGE_DRIVER || 'local').toLowerCase() !== 's3') return (current = new LocalStorage());
  const mb = Number(process.env.STORAGE_CACHE_MB ?? 48);
  const s3 = S3Storage.fromEnv();
  return (current = mb > 0 ? new CachedStorage(s3, mb * 1024 * 1024) : s3);
}
/** tests */
export function setStorage(s: FileStorage | null) { current = s; }
