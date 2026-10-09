import * as crypto from 'crypto';
import { diskStorage } from 'multer';
import * as path from 'path';
import { AppError } from './errors';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
/** Multer options for image uploads (JPG/PNG/WEBP ≤ 3MB) into ./uploads, served at /uploads/. */
export const imageUploadOptions = {
  storage: diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req: any, file: Express.Multer.File, cb: (e: Error | null, ok: boolean) => void) =>
    /^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(new AppError(400, 'INVALID_FILE', 'Chỉ nhận ảnh JPG, PNG hoặc WEBP'), false),
};
