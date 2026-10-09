import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { detectImage, uploadDir } from '../common/upload';
import { AppError } from '../common/errors';

export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const PHOTO_MAX_FILES = 20;
const FULL_PX = 2048, THUMB_PX = 400;

/** JPEG / PNG / WebP / HEIC(HEIF) by magic bytes only. */
export function detectPhoto(buf: Buffer): 'jpg' | 'png' | 'webp' | 'heif' | null {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return detectImage(buf);
}

export interface ProcessedPhoto { full: Buffer; thumb: Buffer; width: number; height: number }

const unsupported = (name: string) => new AppError(400, 'UNSUPPORTED_IMAGE', `File "${name}" không phải ảnh JPG/PNG/WebP/HEIC hợp lệ`, { file: name });

/** Validates + converts to JPEG (auto-rotated, EXIF/GPS stripped – sharp drops metadata by default), full ≤2048px + thumb 400px. */
export async function processPhoto(buf: Buffer, name: string): Promise<ProcessedPhoto> {
  const kind = detectPhoto(buf);
  if (!kind) throw unsupported(name);
  let src = buf;
  if (kind === 'heif') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      src = Buffer.from(await require('heic-convert')({ buffer: buf, format: 'JPEG', quality: 0.92 }));
    } catch { throw unsupported(name); }
  }
  try {
    const full = await sharp(src, { failOn: 'error' }).rotate().resize({ width: FULL_PX, height: FULL_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const thumb = await sharp(full.data).resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { full: full.data, thumb, width: full.info.width, height: full.info.height };
  } catch { throw unsupported(name); }
}

export const photoDir = (classId: string) => path.join(uploadDir(), 'photos', classId);

/** Writes both files; returns keys relative to UPLOAD_DIR. */
export function storePhoto(classId: string, p: ProcessedPhoto) {
  const dir = photoDir(classId), id = crypto.randomUUID();
  fs.mkdirSync(dir, { recursive: true });
  const fileKey = `photos/${classId}/${id}.jpg`, thumbKey = `photos/${classId}/${id}_t.jpg`;
  fs.writeFileSync(path.join(uploadDir(), fileKey), p.full, { flag: 'wx' });
  fs.writeFileSync(path.join(uploadDir(), thumbKey), p.thumb, { flag: 'wx' });
  return { fileKey, thumbKey };
}

export function removePhotoFiles(keys: string[]) {
  for (const k of keys) fs.rm(path.join(uploadDir(), k), { force: true }, () => undefined);
}

/** Resolves a stored key strictly inside UPLOAD_DIR/photos. */
export function photoPath(key: string) {
  const base = path.resolve(uploadDir(), 'photos');
  const p = path.resolve(uploadDir(), key);
  if (!p.startsWith(base + path.sep)) throw new AppError(404, 'NOT_FOUND', 'Không có ảnh');
  return p;
}
