import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  compressGrarecoImageUrl,
  extensionForMime,
  grarecoWebpQuality,
  parseImageDataUrl,
  toEmailAttachmentImage,
  withCompressedGrarecoImage,
} from '../grareco/grarecoImageCompress.js';

const makePngDataUrl = async (width: number, height: number) => {
  const png = await sharp({ create: { width, height, channels: 3, background: { r: 250, g: 240, b: 220 } } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
};

describe('グラレコの画像を保存前に WebP にする', () => {
  it('品質の既定は 85、0 で変換しない、範囲外はおさめる', () => {
    expect(grarecoWebpQuality({})).toBe(85);
    expect(grarecoWebpQuality({ GRARECO_WEBP_QUALITY: '0' })).toBe(0);
    expect(grarecoWebpQuality({ GRARECO_WEBP_QUALITY: '70' })).toBe(70);
    expect(grarecoWebpQuality({ GRARECO_WEBP_QUALITY: '150' })).toBe(100);
    expect(grarecoWebpQuality({ GRARECO_WEBP_QUALITY: 'abc' })).toBe(85);
  });

  it('PNG を同じ寸法の WebP にし、大きさと時間をログに出す', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const src = await makePngDataUrl(320, 180);
    const out = await compressGrarecoImageUrl(src, 'test', 85);
    const parsed = parseImageDataUrl(out)!;
    expect(parsed.mimeType).toBe('image/webp');
    const meta = await sharp(parsed.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(180);
    expect(log.mock.calls.some((c) => String(c[0]).includes('[grareco:webp]') && String(c[0]).includes('ms'))).toBe(true);
    log.mockRestore();
  });

  it('品質 0 なら変換しない', async () => {
    const src = await makePngDataUrl(10, 10);
    expect(await compressGrarecoImageUrl(src, 'test', 0)).toBe(src);
  });

  it('変換に失敗したら元の画像のまま返す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`;
    expect(await compressGrarecoImageUrl(broken, 'test', 85)).toBe(broken);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('データ URL でないものや WebP はそのまま返す', async () => {
    expect(await compressGrarecoImageUrl('https://example.com/a.png', 'test', 85)).toBe('https://example.com/a.png');
    const webp = `data:image/webp;base64,${(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).webp().toBuffer()).toString('base64')}`;
    expect(await compressGrarecoImageUrl(webp, 'test', 85)).toBe(webp);
  });

  it('結果のほかの項目は変えない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await withCompressedGrarecoImage({ imageUrl: await makePngDataUrl(8, 8), modelUsed: 'sample-model' }, 'test');
    expect(out.modelUsed).toBe('sample-model');
    log.mockRestore();
  });
});

describe('メールの添付', () => {
  it('JPEG にして拡張子を jpg にする', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const webpUrl = await compressGrarecoImageUrl(await makePngDataUrl(64, 48), 'test', 85);
    log.mockRestore();
    const att = await toEmailAttachmentImage(webpUrl);
    expect(att!.extension).toBe('jpg');
    const meta = await sharp(att!.content).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(64);
  });

  it('JPEG にできなければ、元の画像を中身に合った拡張子で添付する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = `data:image/webp;base64,${Buffer.from('broken').toString('base64')}`;
    const att = await toEmailAttachmentImage(broken);
    expect(att!.extension).toBe('webp');
    expect(att!.content.toString()).toBe('broken');
    warn.mockRestore();
  });

  it('データ URL でなければ添付しない', async () => {
    expect(await toEmailAttachmentImage('https://example.com/a.png')).toBeNull();
  });

  it('形式ごとの拡張子', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
  });
});
