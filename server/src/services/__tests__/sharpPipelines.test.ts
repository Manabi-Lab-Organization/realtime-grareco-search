import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { reprojectEquirectToViews } from '../equirectReproject.js';

const makePng = (width: number, height: number, alpha = false) =>
  sharp({ create: { width, height, channels: alpha ? 4 : 3, background: { r: 200, g: 80, b: 40, alpha: 1 } } }).png().toBuffer();

describe('sharp を使った画像の変換', () => {
  it('大きい画像を 1600px 以内に縮めて JPEG にし、小さい画像は拡大しない', async () => {
    const out = await sharp(await makePng(3200, 1800))
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(900);

    const small = await sharp(await makePng(400, 300))
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    expect((await sharp(small).metadata()).width).toBe(400);
  });

  it('幅 480px の WebP の縮小画像を作る', async () => {
    const out = await sharp(await makePng(1200, 800))
      .resize({ width: 480, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(480);
  });

  it('全方位の画像から 4 方向の JPEG 画像を作る', async () => {
    const views = await reprojectEquirectToViews(await makePng(512, 256, true));
    expect(views).toHaveLength(4);
    for (const v of views) expect((await sharp(v).metadata()).format).toBe('jpeg');
  });
});
