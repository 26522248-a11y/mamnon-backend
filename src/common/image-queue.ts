/**
 * B31 (PM): Render Free has 512 MB RAM – decode/resize at most IMAGE_PROCESS_CONCURRENCY images at a time (default 1),
 * queue up to IMAGE_QUEUE_MAX more (default 10); beyond that the upload fails fast with 503 instead of exhausting memory.
 * libvips itself is limited to 1 worker thread and its operation cache is off (inputs are never reused).
 */
import { AppError } from './errors';

let sharpConfigured = false;
export function configureSharp() {
  if (sharpConfigured) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');
  sharp.concurrency(1);
  sharp.cache(false);
  sharpConfigured = true;
}

export const QUEUE_FULL_MESSAGE = 'Máy chủ đang xử lý nhiều ảnh cùng lúc, vui lòng thử lại sau ít phút';

export class ImageQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly concurrency = 1, readonly maxQueue = 10) {}
  get stats() { return { active: this.active, waiting: this.waiting.length }; }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw Object.assign(new AppError(503, 'IMAGE_QUEUE_FULL', QUEUE_FULL_MESSAGE), { retryAfter: 30 });
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot straight to the next waiter (active count unchanged)
      else this.active--;
    }
  }
}

const intEnv = (v: string | undefined, d: number, min: number) => { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.floor(n) : d; };
let current: ImageQueue | null = null;
export function imageQueue(): ImageQueue {
  configureSharp();
  return (current ??= new ImageQueue(intEnv(process.env.IMAGE_PROCESS_CONCURRENCY, 1, 1), intEnv(process.env.IMAGE_QUEUE_MAX, 10, 0)));
}
/** tests */
export function setImageQueue(q: ImageQueue | null) { current = q; }
