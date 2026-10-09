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
 * B31: re-encode every uploaded photo before storing (Backblaze B2 free tier: 1 GB download/day). Auto-rotate from EXIF,
 * cap the long edge, JPEG (alpha flattened on white), and NO metadata kept (sharp drops EXIF/GPS/XMP unless asked) – privacy.
 */
export const IMAGE_PROFILES = {
  photo: { edge: 1280, quality: 80 },     // pickup / pickup-request / picker / medicine photos
  avatar: { edge: 512, quality: 80 },     // child profile photo
  document: { edge: 2048, quality: 85 },  // receipt images: keep small print readable
} as const;
export type ImageProfile = keyof typeof IMAGE_PROFILES;

export async function normalizeImage(src: Buffer, profile: ImageProfile = 'photo'): Promise<Buffer> {
  const { edge, quality } = IMAGE_PROFILES[profile];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require('sharp');
    return await sharp(src).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
  } catch {
    throw BadRequest('Ảnh bị hỏng hoặc không đọc được', 'INVALID_FILE');
  }
}

/**
 * Validates and stores an uploaded image; returns the storage key (file name). Accepts JPG, PNG and HEIC/HEIF
 * (always stored as a resized, metadata-free JPEG). Anything else, including a non-image renamed to .heic/.jpg -> 400 INVALID_FILE.
 * B27: written through storage() (local dir or S3/R2/B2), never straight to the container disk.
 * Keys are a fresh UUID per upload, so a stored key never changes content (lets responses be cached / ETagged by key).
 */
export async function saveImage(file?: Express.Multer.File, profile: ImageProfile = 'photo'): Promise<string> {
  if (!file?.buffer?.length) throw BadRequest('Thiếu file ảnh', 'INVALID_FILE');
  const kind = detectImage(file.buffer);
  if (!kind) throw BadRequest('File không phải ảnh JPG/PNG/HEIC hợp lệ', 'INVALID_FILE');
  const data = await normalizeImage(kind === 'heif' ? await heifToJpeg(file.buffer) : file.buffer, profile);
  const key = `${crypto.randomUUID()}.jpg`;
  await storage().put(key, data, 'image/jpeg');
  return key;
}

/** Stored values may be legacy "/uploads/<key>" or just "<key>"; never trust them as paths. */
export const keyOf = (stored: string) => path.basename(stored);

export const contentTypeOf = (key: string) => (key.endsWith('.pdf') ? 'application/pdf' : key.endsWith('.png') ? 'image/png' : 'image/jpeg');

/** Best-effort delete (old photo replaced / removed); never fails the request. */
export async function removeImage(stored?: string | null) {
  if (stored) await storage().remove(keyOf(stored)).catch(() => undefined);
}

/**
 * B31 caching. Keys written by this app are `<uuid>.<ext>` (optionally under a folder, `_thumb` suffix) and are never
 * overwritten → the key identifies the bytes, so ETag = hash(key) and a matching If-None-Match is answered 304 WITHOUT
 * reading the object (no B2 GetObject). Other keys (seed `avatar-<childId>.png`, legacy names) can be rewritten → no ETag.
 *  - 'immutable'  : the URL always maps to the same key (pickup, pickup-request, medicine, class & announcement photos)
 *  - 'revalidate' : the URL's key can change (child photo, picker photo replaced) → `no-cache` + ETag (cheap 304)
 *  - 'no-store'   : sensitive documents (finance receipts)
 */
export type CacheMode = 'immutable' | 'revalidate' | 'no-store';
const IMMUTABLE_KEY = /^(?:[a-z0-9_-]+\/)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_thumb)?\.(?:jpg|png|pdf)$/i;
export const isImmutableKey = (key: string) => IMMUTABLE_KEY.test(key);
export const etagOf = (key: string) => `"k-${crypto.createHash('sha256').update(key).digest('base64url').slice(0, 27)}"`;
const matchesEtag = (header: string | string[] | undefined, tag: string) =>
  !!header && String(header).split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === tag || t === '*');

export function cacheHeaders(key: string, mode: CacheMode): { cacheControl: string; etag: string | null } {
  if (mode === 'no-store') return { cacheControl: 'private, no-store', etag: null };
  if (!isImmutableKey(key)) return { cacheControl: mode === 'immutable' ? 'private, max-age=3600' : 'private, no-cache', etag: null };
  return { cacheControl: mode === 'immutable' ? 'private, max-age=31536000, immutable' : 'private, no-cache', etag: etagOf(key) };
}

/**
 * Sends one stored object from an endpoint that has ALREADY checked permissions. 304 (no storage read) when the client
 * already has this exact key; 404 when the object is gone.
 */
export async function sendKey(res: Response, key: string, opts: { mode: CacheMode; notFound: string; contentType?: string; extra?: Record<string, string> }) {
  const { cacheControl, etag } = cacheHeaders(key, opts.mode);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (etag) {
    res.setHeader('ETag', etag);
    if (matchesEtag(res.req?.headers['if-none-match'], etag)) { res.status(304).end(); return; }
  }
  const buf = await storage().get(key);
  if (!buf) { res.removeHeader('ETag'); res.removeHeader('Cache-Control'); throw NotFound(opts.notFound); }
  res.setHeader('Content-Type', opts.contentType ?? contentTypeOf(key));
  for (const [k, v] of Object.entries(opts.extra ?? {})) res.setHeader(k, v);
  res.end(buf);
}

/** Streams a stored file through the (already permission-checked) endpoint; 404 when the record has no file or it is gone. */
export async function sendStored(res: Response, stored: string | null | undefined, notFound: string, extra: Record<string, string> = {}, mode: CacheMode = 'no-store') {
  if (!stored) throw NotFound(notFound);
  await sendKey(res, keyOf(stored), { mode, notFound, extra });
}

export const sendImage = (res: Response, stored: string | null | undefined, mode: CacheMode = 'immutable') => sendStored(res, stored, 'Không có ảnh', {}, mode);

/**
 * B29: multer/busboy hands `originalname` over as latin1-decoded bytes, so "hóa đơn.pdf" arrives as "hÃ³a Ä‘Æ¡n.pdf".
 * Re-decode as UTF-8 (NFC). Left untouched when it already contains non-latin1 chars or is not valid UTF-8.
 */
export function decodeOriginalName(name?: string | null): string {
  if (!name) return '';
  if (/[^\x00-\xff]/.test(name)) return name.normalize('NFC');
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return (utf8.includes('\uFFFD') ? name : utf8).normalize('NFC');
}

/** ASCII-only fallback for old clients: strip Vietnamese diacritics (đ → d), anything else unsafe → "_". */
export function asciiFileName(name: string): string {
  const a = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  return a || 'file';
}

/** RFC 6266 / 5987 Content-Disposition: `type; filename="ascii"; filename*=UTF-8''percent-encoded`. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${asciiFileName(name)}"; filename*=UTF-8''${enc}`;
}
