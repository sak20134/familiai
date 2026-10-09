// Safe handling of image bytes: only real images, only small ones, only from the allowed host.

import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_DOWNLOAD_HOST = 'api.openverse.org';

export type ImageType = 'png' | 'gif' | 'jpeg' | 'webp';

/** Decide the type from the first bytes, never from the file name. */
export function detectImageType(buf: Uint8Array): ImageType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) return 'webp';
  return null;
}

export type ImageCheck = { ok: true; type: ImageType } | { ok: false; error: string };

export function validateImage(buf: Uint8Array): ImageCheck {
  if (buf.length === 0) return { ok: false, error: 'The file is empty.' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: 'The image is bigger than 5 MB.' };
  const type = detectImageType(buf);
  if (!type) return { ok: false, error: 'This is not a PNG, GIF, JPEG or WebP image.' };
  return { ok: true, type };
}

/** Only download from our one image source, over https. Stops the app being pointed at other servers. */
export function isAllowedDownloadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === ALLOWED_DOWNLOAD_HOST && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

const PNG_PREFIX = 'data:image/png;base64,';

/** Turns a PNG data URL (made by the background remover) into bytes, or null if it is not one. */
export function pngDataUrlToBuffer(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith(PNG_PREFIX)) return null;
  const b64 = dataUrl.slice(PNG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  return detectImageType(buf) === 'png' ? buf : null;
}

export function fileNameFor(buf: Uint8Array, type: ImageType): string {
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return `${hash}.${type === 'jpeg' ? 'jpg' : type}`;
}
