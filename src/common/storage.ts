/**
 * File storage abstraction.
 *  - STORAGE_DRIVER=local (default): files in UPLOAD_DIR (Render persistent disk /var/data/uploads, Docker volume…).
 *  - STORAGE_DRIVER=s3: any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) –
 *    S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET, optional S3_REGION (default "auto"), S3_PUBLIC_BASE.
 * Files are always streamed through permission-checked API endpoints (children's photos stay private); S3_PUBLIC_BASE is only
 * reported by publicUrl() for non-sensitive assets and is never used for announcement images.
 */
import * as fs from 'fs';
import * as path from 'path';
import { uploadDir } from './upload';

export interface FileStorage {
  readonly driver: 'local' | 's3';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string | null;
}

const safeKey = (key: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,200}$/.test(key) || key.includes('..')) throw new Error(`invalid storage key: ${key}`);
  return key;
};

export class LocalStorage implements FileStorage {
  readonly driver = 'local' as const;
  constructor(private dir = uploadDir()) {}
  private file(key: string) { return path.join(this.dir, safeKey(key)); }
  async put(key: string, data: Buffer) { const f = this.file(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); }
  async get(key: string) { const f = this.file(key); return fs.existsSync(f) ? fs.readFileSync(f) : null; }
  async remove(key: string) { fs.rmSync(this.file(key), { force: true }); }
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
  publicUrl(key: string) { return this.publicBase ? `${this.publicBase.replace(/\/+$/, '')}/${safeKey(key)}` : null; }
}

let current: FileStorage | null = null;
export function storage(): FileStorage {
  return (current ??= (process.env.STORAGE_DRIVER || 'local').toLowerCase() === 's3' ? S3Storage.fromEnv() : new LocalStorage());
}
/** tests */
export function setStorage(s: FileStorage | null) { current = s; }
