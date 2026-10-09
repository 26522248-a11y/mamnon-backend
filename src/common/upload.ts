import * as crypto from 'crypto';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { BadRequest, NotFound } from './errors';
import { storage, uploadDir } from './storage';

/** Re-exported for older imports; the local driver lives in ./storage. */
export { uploadDir };
const MAX_BYTES = 3 * 1024 * 1024;

/** Multer options: keep the upload in memory so the real content can be checked before anything touches disk. */
export const imageUploadOptions = { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } };

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif']);

/**
 * Detect image type from the real content (filename / Content-Type are ignored): JPEG, PNG, or HEIC/HEIF
 * (ISO-BMFF 'ftyp' box whose major or compatible brands include heic/heix/hevc/heif/mif1/…).
 */
export function detectImage(buf: Buffer): 'jpg' | 'png' | 'heif' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 16 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const boxSize = buf.readUInt32BE(0);
    const end = Math.min(boxSize >= 16 ? boxSize : 16, buf.length, 4096);
    const brands = [buf.toString('latin1', 8, 12)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(buf.toString('latin1', i, i + 4));
    if (brands.some((b) => HEIF_BRANDS.has(b))) return 'heif';
  }
  return null;
}

/** HEIC/HEIF (iPhone photos) -> JPEG, so every stored photo displays in any browser. Undecodable -> 400. */
export async function heifToJpeg(buf: Buffer): Promise<Buffer> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const convert = require('heic-convert');
    const out = Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: 0.85 }));
    if (detectImage(out) !== 'jpg') throw new Error('not jpeg');
    return out;
  } catch {
    throw BadRequest('File HEIC/HEIF bị hỏng hoặc không đọc được', 'INVALID_FILE');
  }
}

/**
 * Validates and stores an uploaded image; returns the storage key (file name). Accepts JPG, PNG and HEIC/HEIF
 * (converted to JPEG on save). Anything else, including a non-image renamed to .heic/.jpg -> 400 INVALID_FILE.
 * B27: written through storage() (local dir or S3/R2), never straight to the container disk.
 */
export async function saveImage(file?: Express.Multer.File): Promise<string> {
  if (!file?.buffer?.length) throw BadRequest('Thiếu file ảnh', 'INVALID_FILE');
  const kind = detectImage(file.buffer);
  if (!kind) throw BadRequest('File không phải ảnh JPG/PNG/HEIC hợp lệ', 'INVALID_FILE');
  const data = kind === 'heif' ? await heifToJpeg(file.buffer) : file.buffer;
  const key = `${crypto.randomUUID()}.${kind === 'png' ? 'png' : 'jpg'}`;
  await storage().put(key, data, contentTypeOf(key));
  return key;
}

/** Stored values may be legacy "/uploads/<key>" or just "<key>"; never trust them as paths. */
export const keyOf = (stored: string) => path.basename(stored);

export const contentTypeOf = (key: string) => (key.endsWith('.pdf') ? 'application/pdf' : key.endsWith('.png') ? 'image/png' : 'image/jpeg');

/** Best-effort delete (old photo replaced / removed); never fails the request. */
export async function removeImage(stored?: string | null) {
  if (stored) await storage().remove(keyOf(stored)).catch(() => undefined);
}

/** Streams a stored file through the (already permission-checked) endpoint; 404 when the record has no file or it is gone. */
export async function sendStored(res: Response, stored: string | null | undefined, notFound: string, extra: Record<string, string> = {}) {
  if (!stored) throw NotFound(notFound);
  const key = keyOf(stored);
  const buf = await storage().get(key);
  if (!buf) throw NotFound(notFound);
  res.setHeader('Content-Type', contentTypeOf(key));
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buf);
}

export const sendImage = (res: Response, stored?: string | null) => sendStored(res, stored, 'Không có ảnh');
