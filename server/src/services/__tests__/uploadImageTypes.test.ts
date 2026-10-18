import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { looksLikeMarkupImage, uploadImageData, uploadImageMimeType } from '../uploadImageTypes.js';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('アップロード画像の形式チェック', () => {
  it('許可した画像の MIME タイプだけを受け付ける', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']) {
      expect(uploadImageMimeType.safeParse(t).success).toBe(true);
    }
    for (const t of ['image/svg+xml', 'image/bmp', 'text/html', 'image/']) {
      expect(uploadImageMimeType.safeParse(t).success).toBe(false);
    }
  });

  it('中身がマークアップや gzip のデータを拒否する', () => {
    expect(looksLikeMarkupImage(b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
    expect(looksLikeMarkupImage(b64('\uFEFF  \n<?xml version="1.0"?><svg/>'))).toBe(true);
    expect(looksLikeMarkupImage(b64(Buffer.from([0x1f, 0x8b, 0x08, 0x00])))).toBe(true);
    expect(uploadImageData.safeParse(b64('<svg/>')).success).toBe(false);
  });

  it('PNG と JPEG のデータを受け付ける', async () => {
    const img = sharp({ create: { width: 8, height: 8, channels: 3, background: '#aa6699' } });
    const png = await img.clone().png().toBuffer();
    const jpeg = await img.clone().jpeg().toBuffer();
    expect(uploadImageData.safeParse(png.toString('base64')).success).toBe(true);
    expect(uploadImageData.safeParse(jpeg.toString('base64')).success).toBe(true);
  });

  it('空のデータを拒否する', () => {
    expect(uploadImageData.safeParse('').success).toBe(false);
  });
});
