
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import sharp from 'sharp';

const DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

export function sendGrarecoImage(req: Request, res: Response, imageUrl: string | null): void {
  if (!imageUrl) {
    res.status(404).json({ error: '画像がありません' });
    return;
  }
  const m = imageUrl.match(DATA_URL_RE);
  if (!m) {
    res.redirect(imageUrl);
    return;
  }
  const etag = `"${crypto.createHash('md5').update(m[2]).digest('hex')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.set('Content-Type', m[1]);
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  res.send(Buffer.from(m[2], 'base64'));
}

const THUMB_WIDTH = 640;
const THUMB_CACHE_MAX = 300;
const thumbCache = new Map<string, Buffer>();

export async function sendGrarecoThumbnail(
  req: Request,
  res: Response,
  hash: string | null,
  loadImage: () => Promise<string | null>,
): Promise<void> {
  if (!hash) {
    res.status(404).json({ error: '画像がありません' });
    return;
  }
  const etag = `"${hash}-w${THUMB_WIDTH}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  let thumb = thumbCache.get(hash);
  if (thumb) {
    thumbCache.delete(hash);
    thumbCache.set(hash, thumb);
  } else {
    const imageUrl = await loadImage();
    const m = imageUrl?.match(DATA_URL_RE);
    if (!imageUrl || !m) {
      sendGrarecoImage(req, res, imageUrl ?? null);
      return;
    }
    thumb = await sharp(Buffer.from(m[2], 'base64'))
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    thumbCache.set(hash, thumb);
    if (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value!);
  }
  res.set('Content-Type', 'image/webp');
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  res.send(thumb);
}
