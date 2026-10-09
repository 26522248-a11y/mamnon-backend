import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { storage } from './storage';

/** Small real PNG placeholder avatar (silhouette on a pastel background), generated without native deps. */
const PALETTE: [number, number, number][] = [
  [255, 205, 210], [248, 187, 208], [225, 190, 231], [197, 202, 233], [187, 222, 251],
  [178, 235, 242], [200, 230, 201], [240, 244, 195], [255, 236, 179], [255, 224, 178],
];

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

export function placeholderAvatarPng(seed: number, size = 128): Buffer {
  const bg = PALETTE[Math.abs(seed) % PALETTE.length];
  const fg: [number, number, number] = [255, 255, 255];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const cx = size / 2, headY = size * 0.4, headR = size * 0.2, bodyY = size * 0.98, bodyRx = size * 0.36, bodyRy = size * 0.3;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const head = (x - cx) ** 2 + (y - headY) ** 2 <= headR ** 2;
      const body = ((x - cx) / bodyRx) ** 2 + ((y - bodyY) / bodyRy) ** 2 <= 1;
      const c = head || body ? fg : bg;
      raw.set(c, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Designer avatars shipped with the backend (assets/avatars/avatar-01.png..avatar-10.png). */
export const avatarAssetDir = () => process.env.AVATAR_ASSET_DIR || path.resolve(__dirname, '..', '..', 'assets', 'avatars');
const designerAvatars = () => {
  const dir = avatarAssetDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^avatar-\d+\.png$/.test(f)).sort().map((f) => path.join(dir, f)) : [];
};

/**
 * Writes a per-child placeholder file (own file per child, so replacing one photo never deletes another's).
 * Cycles the designer avatars by `index`; falls back to a generated PNG if the assets are missing. Returns the storage key.
 */
export async function writePlaceholderAvatar(childId: string, index: number): Promise<string> {
  const key = `avatar-${childId}.png`;
  const assets = designerAvatars();
  const data = assets.length ? fs.readFileSync(assets[Math.abs(index) % assets.length]) : placeholderAvatarPng(index);
  await storage().put(key, data, 'image/png'); // B27: local dir or S3/R2
  return key;
}
