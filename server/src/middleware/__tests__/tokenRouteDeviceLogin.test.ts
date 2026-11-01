import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const issueApiToken = vi.fn();
const revokeTokensOfType = vi.fn();
const audit = vi.fn();

vi.mock('../../db/index.js', () => ({ db: {}, pool: {} }));
vi.mock('../../services/authService.js', () => ({}));
vi.mock('../../services/authSessionService.js', () => ({}));
vi.mock('../../services/initialSetupCode.js', () => ({}));
vi.mock('../rateLimit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authLimiter: pass, loginAccountLimiter: pass, registerLimiter: pass, passwordResetLimiter: pass, inviteLimiter: pass };
});
vi.mock('../auth.js', () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.auth = { userId: 7, method: 'session' };
    next();
  },
}));
vi.mock('../recentAuth.js', () => ({
  requireRecentAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  hasRecentAuth: vi.fn(),
  markRecentAuth: vi.fn(),
}));
vi.mock('../../services/audit/audit.js', () => ({
  audit: (...args: unknown[]) => audit(...args),
  auditAuthFailure: vi.fn(),
}));
vi.mock('../../services/apiTokenService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/apiTokenService.js')>()),
  issueApiToken: (...args: unknown[]) => issueApiToken(...args),
  revokeTokensOfType: (...args: unknown[]) => revokeTokensOfType(...args),
}));

let server: Server;
let url: string;

beforeAll(async () => {
  const { default: authRouter } = await import('../../routes/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/token`;
});

afterAll(() => new Promise((resolve) => { server.close(resolve); }));

beforeEach(() => {
  vi.clearAllMocks();
  issueApiToken.mockResolvedValue({ token: 'abcd1234', id: 1 });
  revokeTokensOfType.mockResolvedValue(1);
});

function post(body?: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/auth/token', () => {
  it.each(['desktop', 'mobile'])('%s は端末専用の鍵を出し、何も無効にしない', async (clientType) => {
    const res = await post({ deviceName: 'サンプルの端末', clientType });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'abcd1234' });
    expect(revokeTokensOfType).not.toHaveBeenCalled();
    expect(issueApiToken).toHaveBeenCalledWith(7, expect.objectContaining({ clientType, deviceName: 'サンプルの端末' }));
  });

  it('2 台が交互に呼んでも、無効にする処理は走らない', async () => {
    await post({ deviceName: '1 台目', clientType: 'desktop' });
    await post({ deviceName: '2 台目', clientType: 'desktop' });
    await post({ deviceName: '1 台目', clientType: 'desktop' });
    expect(issueApiToken).toHaveBeenCalledTimes(3);
    expect(revokeTokensOfType).not.toHaveBeenCalled();
  });

  it.each([[undefined], [{}], [{ clientType: 'api' }]])('本文が %j なら外部連携用の鍵を作り直す', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(revokeTokensOfType).toHaveBeenCalledWith(7, 'api', 'rotated');
    expect(issueApiToken).toHaveBeenCalledWith(7, expect.objectContaining({ clientType: 'api' }));
  });
});
