import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import type { Request, Response } from 'express';
import { sendGrarecoImage, sendGrarecoThumbnail } from '../grareco/grarecoImageResponse.js';

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    set: (name: string, value: string) => { headers[name] = value; return res; },
    send: vi.fn(() => res),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
    end: vi.fn(() => res),
    redirect: vi.fn(),
  };
  return { res: res as unknown as Response, headers, send: res.send };
}

const request = { headers: {} } as Request;

async function samplePngDataUrl(): Promise<string> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function expectSafetyHeaders(headers: Record<string, string>) {
  expect(headers['Content-Security-Policy']).toBe("default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  expect(headers['X-Content-Type-Options']).toBe('nosniff');
}

describe('グラレコの画像の応答', () => {
  it('元の画像に安全のヘッダを付ける', async () => {
    const { res, headers, send } = fakeResponse();
    sendGrarecoImage(request, res, await samplePngDataUrl());
    expect(send).toHaveBeenCalledTimes(1);
    expectSafetyHeaders(headers);
  });

  it('縮小画像を作って返すときも、作り置きを返すときも、同じヘッダを付ける', async () => {
    const dataUrl = await samplePngDataUrl();
    const loadImage = vi.fn(async () => dataUrl);

    const created = fakeResponse();
    await sendGrarecoThumbnail(request, created.res, 'sample-hash', loadImage);
    expect(created.headers['Content-Type']).toBe('image/webp');
    expectSafetyHeaders(created.headers);

    const cached = fakeResponse();
    await sendGrarecoThumbnail(request, cached.res, 'sample-hash', loadImage);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expectSafetyHeaders(cached.headers);
  });
});
