import { z } from 'zod';

export const UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'] as const;

export const uploadImageMimeType = z.enum(UPLOAD_IMAGE_TYPES);

export function looksLikeMarkupImage(base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 256), 'base64');
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  if (head[i] === 0x3c) return true;
  if (head[0] === 0x1f && head[1] === 0x8b) return true;
  return false;
}

export const uploadImageData = z
  .string()
  .min(1)
  .refine((s) => !looksLikeMarkupImage(s), { message: 'この形式の画像は受け付けていません' });
