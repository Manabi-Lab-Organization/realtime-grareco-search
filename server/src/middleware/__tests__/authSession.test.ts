import { describe, it, expect, vi, beforeEach } from 'vitest';

const executed: string[] = [];
vi.mock('../../db/index.js', () => ({
  db: {
    execute: vi.fn(async (q: any) => {
      executed.push(JSON.stringify(q?.queryChunks ?? q));
      return { rowCount: 2 };
    }),
  },
}));
const revokeAllTokens = vi.fn(async () => 3);
vi.mock('../../services/apiTokenService.js', () => ({ revokeAllTokens: (...a: unknown[]) => (revokeAllTokens as any)(...a) }));
vi.mock('../../websocket/meetingRegistry.js', () => ({ listActiveRecordings: () => [], forceCleanupMeeting: vi.fn() }));
const broadcasts: Array<{ userId: number; event: string }> = [];
const filtered: Array<(s: any) => boolean> = [];
vi.mock('../../services/research/connectionRegistry.js', () => ({
  broadcastToUser: (userId: number, event: string) => { broadcasts.push({ userId, event }); return { sent: 1, pruned: 0 }; },
  broadcastToUserWhere: (_u: number, _e: string, _d: unknown, pred: (s: any) => boolean) => { filtered.push(pred); return 1; },
}));
const audits: Array<{ event: string; opts: any }> = [];
vi.mock('../../services/audit/audit.js', () => ({
  audit: vi.fn(async (event: string, opts: any) => { audits.push({ event, opts }); }),
}));

import { invalidateAllUserAccess, logoutOtherDevices } from '../../services/authSessionService.js';

describe('ログイン状態の取り消し', () => {
  beforeEach(() => { executed.length = 0; audits.length = 0; broadcasts.length = 0; filtered.length = 0; revokeAllTokens.mockClear(); });

  it('invalidateAllUserAccess はすべてのトークンを無効にし、理由を記録して通知する', async () => {
    await invalidateAllUserAccess(42, 'password.change');
    expect(revokeAllTokens).toHaveBeenCalledWith(42, 'password.change');
    const a = audits.find((x) => x.event === 'token.revoke');
    expect(a?.opts.detail).toMatchObject({ reason: 'password.change', scope: 'all', revokedTokens: 3 });
    expect(broadcasts).toEqual([{ userId: 42, event: 'session_invalidated' }]);
    expect(executed.some((q) => q.includes('DELETE FROM session'))).toBe(true);
  });

  it('logoutOtherDevices は今のトークンを残して無効にし、今の接続には通知しない', async () => {
    const r = await logoutOtherDevices(42, { tokenId: 7, sessionId: null });
    expect(revokeAllTokens).toHaveBeenCalledWith(42, 'logout_others', 7);
    expect(r).toEqual({ revokedTokens: 3, deletedSessions: 2 });
    const pred = filtered[0];
    expect(pred({ tokenId: 7 })).toBe(false);
    expect(pred({ tokenId: 8 })).toBe(true);
    expect(pred({ sessionId: 'abc' })).toBe(true);
  });

  it('ブラウザから呼んだときは今のセッションを残す', async () => {
    await logoutOtherDevices(42, { tokenId: null, sessionId: 'sid-1' });
    expect(revokeAllTokens).toHaveBeenCalledWith(42, 'logout_others', null);
    const pred = filtered[0];
    expect(pred({ sessionId: 'sid-1' })).toBe(false);
    expect(pred({ sessionId: 'sid-2' })).toBe(true);
    expect(pred({ tokenId: 1 })).toBe(true);
  });
});
