import { describe, it, expect, vi, beforeEach } from 'vitest';

const isTokenActive = vi.fn();
vi.mock('../../services/apiTokenService.js', () => ({ isTokenActive: (...a: unknown[]) => isTokenActive(...a) }));
vi.mock('../../services/liveMeetingGrace.js', () => ({ hasLiveMeeting: vi.fn(async () => false) }));

import { sessionPolicyMiddleware, applySessionPolicy } from '../sessionPolicy.js';

function fakeReq(session: Record<string, unknown>) {
  const originalSave = vi.fn((cb?: () => void) => cb?.());
  const s = { ...session, save: originalSave, regenerate: vi.fn((cb: () => void) => cb()) };
  return { req: { session: s } as any, originalSave };
}

describe('セッションの確認で例外が起きたときの扱い', () => {
  beforeEach(() => {
    isTokenActive.mockReset();
  });

  it('トークンの確認で例外が起きたらログインしていない状態にし、セッションを保存しない', async () => {
    isTokenActive.mockImplementation(async () => { throw new Error('db down'); });
    const { req, originalSave } = fakeReq({ userId: 7, email: 'a@example.com', apiTokenId: 3, issuedAt: Date.now() });
    const next = vi.fn();
    await sessionPolicyMiddleware(req, {} as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.session.userId).toBeUndefined();
    expect(req.session.apiTokenId).toBeUndefined();
    const cb = vi.fn();
    req.session.save(cb);
    expect(cb).toHaveBeenCalledOnce();
    expect(originalSave).not.toHaveBeenCalled();
  });

  it('トークンが有効ならログインしたままにする', async () => {
    isTokenActive.mockResolvedValue(true);
    const { req } = fakeReq({ userId: 7, apiTokenId: 3, issuedAt: Date.now() });
    await applySessionPolicy(req);
    expect(req.session.userId).toBe(7);
  });

  it('トークンが無効ならセッションを作り直す', async () => {
    isTokenActive.mockResolvedValue(false);
    const { req } = fakeReq({ userId: 7, apiTokenId: 3, issuedAt: Date.now() });
    await applySessionPolicy(req);
    expect(req.session.regenerate).toHaveBeenCalledOnce();
  });
});
