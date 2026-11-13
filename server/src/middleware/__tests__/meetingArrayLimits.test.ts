import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

vi.hoisted(() => {
  process.env.GEMINI_API_KEY ??= 'dummy-for-test';
});

const dbMock = vi.hoisted(() => {
  const row = { id: 1, userId: 7, status: 'completed', participants: [], dismissedParticipantNames: [] };
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) =>
      prop === 'then'
        ? (resolve: (rows: unknown[]) => void) => resolve([row])
        : () => chain,
    apply: () => chain,
  });
  return { chain };
});

vi.mock('../../db/index.js', () => ({ db: dbMock.chain, pool: {} }));
vi.mock('../../config/session.js', () => ({
  sessionMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../auth.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.auth = { userId: Number(req.header('x-user') ?? 7), method: 'session' };
    next();
  },
}));
vi.mock('../../services/audit/audit.js', () => ({
  audit: vi.fn(async () => undefined),
  auditLater: vi.fn(),
}));

describe('会議 API の配列の上限（実際のルーターで）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { default: meetingsRouter } = await import('../../routes/meetings.js');
    const { errorHandler } = await import('../errorHandler.js');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/meetings', meetingsRouter);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => vi.restoreAllMocks());

  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}/api/meetings${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const repeat = <T,>(n: number, value: T): T[] => new Array<T>(n).fill(value);

  const cases: Array<{
    name: string;
    method: string;
    path: string;
    max: number;
    body: (items: unknown[]) => unknown;
    ok: unknown;
    bad: unknown;
  }> = [
    { name: '一括削除の ids', method: 'POST', path: '/bulk-delete', max: 1000, body: (ids) => ({ ids }), ok: 1, bad: '' },
    {
      name: '共有の sharedContents',
      method: 'PATCH',
      path: '/1/share',
      max: 4,
      body: (sharedContents) => ({ sharedContents }),
      ok: 'research',
      bad: 'x',
    },
    {
      name: '共有の除外 research',
      method: 'PATCH',
      path: '/1/share',
      max: 2000,
      body: (research) => ({ excludedItems: { research } }),
      ok: '123',
      bad: 1,
    },
    {
      name: '共有の除外 grareco',
      method: 'PATCH',
      path: '/1/share',
      max: 2000,
      body: (grareco) => ({ excludedItems: { grareco } }),
      ok: '123',
      bad: 1,
    },
    {
      name: '共有の除外 glossary',
      method: 'PATCH',
      path: '/1/share',
      max: 2000,
      body: (glossary) => ({ excludedItems: { glossary } }),
      ok: '用語',
      bad: 1,
    },
    {
      name: '共有の除外 summary',
      method: 'PATCH',
      path: '/1/share',
      max: 2000,
      body: (summary) => ({ excludedItems: { summary } }),
      ok: { startMs: 0, endMs: 1000 },
      bad: 1,
    },
    {
      name: 'PATCH の participants',
      method: 'PATCH',
      path: '/1',
      max: 2000,
      body: (participants) => ({ participants }),
      ok: { name: '山田' },
      bad: { name: '山田' },
    },
    {
      name: 'PUT の participants',
      method: 'PUT',
      path: '/1/participants',
      max: 2000,
      body: (participants) => ({ participants }),
      ok: { name: '山田' },
      bad: { name: '山田' },
    },
  ];

  it.each(cases)('$name: 上限ちょうどは通る', async ({ method, path, max, body, ok }) => {
    const items = max === 4 ? ['glossary', 'research', 'grareco', 'summary'] : repeat(max, ok);
    expect((await send(method, path, body(items))).status).toBe(200);
  });

  it.each(cases)('$name: 上限 + 1 は 400', async ({ method, path, max, body, ok }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await send(method, path, body(repeat(max + 1, ok)))).status).toBe(400);
    expect(warn).toHaveBeenCalled();
  });

  it.each(cases)('$name: 不正な要素が大量でも、エラーは 1 件で止まる', async ({ method, path, body, bad }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await send(method, path, body(repeat(1_000_000, bad)));
    expect(res.status).toBe(400);
    const logged = warn.mock.calls.find(([msg]) => String(msg).includes('ValidationError'));
    expect((logged?.[1] as { issues: unknown[] }).issues).toHaveLength(1);
  }, 30_000);

  it('一括削除の上限超えは、理由が分かる日本語を返す', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await send('POST', '/bulk-delete', { ids: repeat(1001, 1) });
    expect((await res.json()).error).toBe('一度に削除できるのは 1000 件までです');
  });
});

describe('bulkDeleteLimiter（実際の express で）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { createBulkDeleteLimiter } = await import('../rateLimit.js');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.locals.auth = { userId: Number(req.header('x-user')), method: 'session' };
      next();
    });
    app.post('/bulk-delete', createBulkDeleteLimiter(30), (_req, res) => {
      res.json({ deleted: 0 });
    });
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (user: number) =>
    fetch(`${base}/bulk-delete`, { method: 'POST', headers: { 'x-user': String(user) } });

  it('30 回までは通り、31 回目は 429。別の利用者は巻き込まれない', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await post(1)).status).toBe(200);
    }
    expect((await post(1)).status).toBe(429);
    expect((await post(2)).status).toBe(200);
  });
});
