import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { defaultBodyParsers, imageJsonBody, isLargeBodyRoute } from '../bodyLimits.js';
import { errorHandler } from '../errorHandler.js';

describe('isLargeBodyRoute', () => {
  it('画像を受け取る経路を大きな本文の経路と判定する', () => {
    expect(isLargeBodyRoute('POST', '/api/meetings/12/images')).toBe(true);
    expect(isLargeBodyRoute('POST', '/api/meetings/12/participant-images')).toBe(true);
    expect(isLargeBodyRoute('POST', '/api/meetings/12/analyze')).toBe(true);
    expect(isLargeBodyRoute('POST', '/api/agent/meetings/12/attach-image')).toBe(true);
    expect(isLargeBodyRoute('POST', '/api/ext/meetings/12/images')).toBe(true);
    expect(isLargeBodyRoute('POST', '/api/ext/meetings/12/observations')).toBe(true);
  });
  it('それ以外の経路や別のメソッドは対象にしない', () => {
    expect(isLargeBodyRoute('POST', '/api/auth/login')).toBe(false);
    expect(isLargeBodyRoute('POST', '/api/meetings/12/memos')).toBe(false);
    expect(isLargeBodyRoute('POST', '/api/meetings/12/images/extra')).toBe(false);
    expect(isLargeBodyRoute('PUT', '/api/meetings/12/images')).toBe(false);
  });
});

describe('リクエスト本文の大きさの上限', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(...defaultBodyParsers());
    app.post('/api/auth/login', (req, res) => res.json({ ok: true, keys: Object.keys(req.body ?? {}) }));
    app.post('/api/meetings/:id/images', imageJsonBody, (req, res) => res.json({ ok: true, len: String(req.body?.data ?? '').length }));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (path: string, body: string) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('通常の経路で 1MB を超える本文は 413 を返す', async () => {
    const res = await post('/api/auth/login', JSON.stringify({ email: 'a'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('通常の経路で小さな本文は読み取れる', async () => {
    const res = await post('/api/auth/login', JSON.stringify({ email: 'a@example.com' }));
    expect(res.status).toBe(200);
    expect((await res.json()).keys).toEqual(['email']);
  });

  it('画像の経路では 1MB を超える本文も読み取れる', async () => {
    const data = 'A'.repeat(5 * 1024 * 1024);
    const res = await post('/api/meetings/1/images', JSON.stringify({ data, mimeType: 'image/png' }));
    expect(res.status).toBe(200);
    expect((await res.json()).len).toBe(data.length);
  });

  it('形の崩れた JSON は 400 を返す', async () => {
    const res = await post('/api/auth/login', '{"email":');
    expect(res.status).toBe(400);
  });
});
