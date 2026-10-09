import * as crypto from 'crypto';
import { Response } from 'express';
import * as fs from 'fs';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { BadRequest, NotFound } from './errors';

/** Private storage dir (NOT served statically). Files are streamed only through permission-checked endpoints. */
export const uploadDir = () => process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
const MAX_BYTES = 3 * 1024 * 1024;

/** Multer options: keep the upload in memory so the real content can be checked before anything touches disk. */
export const imageUploadOptions = { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } };

/** Detect image type from magic bytes. Only JPEG and PNG are accepted (filename / Content-Type are ignored). */
export function detectImage(buf: Buffer): 'jpg' | 'png' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** Validates and stores an uploaded image; returns the storage key (file name). Throws 400 INVALID_FILE. */
export function saveImage(file?: Express.Multer.File): string {
  if (!file?.buffer?.length) throw BadRequest('Thiếu file ảnh', 'INVALID_FILE');
  const ext = detectImage(file.buffer);
  if (!ext) throw BadRequest('File không phải ảnh JPG/PNG hợp lệ', 'INVALID_FILE');
  const key = `${crypto.randomUUID()}.${ext}`;
  fs.mkdirSync(uploadDir(), { recursive: true });
  fs.writeFileSync(path.join(uploadDir(), key), file.buffer, { flag: 'wx' });
  return key;
}

/** Stored values may be legacy "/uploads/<key>" or just "<key>"; never trust them as paths. */
export const keyOf = (stored: string) => path.basename(stored);

export function removeImage(stored?: string | null) {
  if (stored) fs.rm(path.join(uploadDir(), keyOf(stored)), { force: true }, () => undefined);
}

export function sendImage(res: Response, stored?: string | null) {
  if (!stored) throw NotFound('Không có ảnh');
  const key = keyOf(stored);
  const file = path.join(uploadDir(), key);
  if (!fs.existsSync(file)) throw NotFound('Không có ảnh');
  res.setHeader('Content-Type', key.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
}
