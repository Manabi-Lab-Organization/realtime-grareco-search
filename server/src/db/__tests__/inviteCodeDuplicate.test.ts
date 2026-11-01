import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { query, pass } = vi.hoisted(() => ({
  query: vi.fn(),
  pass: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../index.js', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres');
  return { db: drizzle({ query } as never) };
});

vi.mock('../../middleware/auth.js', () => ({ requireAuth: pass }));
vi.mock('../../middleware/admin.js', () => ({ requireAdmin: pass }));
vi.mock('../../middleware/recentAuth.js', () => ({
  hasRecentAuth: vi.fn(),
  requireRecentAuth: pass,
  sendReauthRequired: vi.fn(),
}));
vi.mock('../../middleware/authContext.js', () => ({
  authUserId: () => 1,
  getAuth: () => ({ email: 'admin@example.com' }),
}));
vi.mock('../../services/accountDeletionService.js', () => ({ deleteUserAccount: vi.fn() }));
vi.mock('../../services/authService.js', () => ({ adminResetPassword: vi.fn() }));
vi.mock('../../websocket/meetingRegistry.js', () => ({
  listActiveRecordings: vi.fn(),
  forceCleanupMeeting: vi.fn(),
}));
vi.mock('../../services/audit/audit.js', () => ({ audit: vi.fn(), auditLater: vi.fn() }));

import adminRouter from '../../routes/admin.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function pgError(code: string): Error {
  return Object.assign(new Error('pg error'), { code });
}

describe('招待コードの作成', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(adminRouter);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => {
    vi.restoreAllMocks();
    query.mockReset();
  });

  const create = () =>
    fetch(`${base}/invite-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'SAMPLE-CODE' }),
    });

  it('同じコードがあれば 409 を返す', async () => {
    query.mockRejectedValue(pgError('23505'));
    const res = await create();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('duplicate_code');
  });

  it('ほかの失敗は 500 のままで、クエリとパラメータを応答とログに出さない', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(pgError('23503'));
    const res = await create();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('SAMPLE-CODE');
    expect(body).not.toContain('Failed query');
    expect(JSON.stringify(log.mock.calls)).not.toContain('Failed query');
  });
});
