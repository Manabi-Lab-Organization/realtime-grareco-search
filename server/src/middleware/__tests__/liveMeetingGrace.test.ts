import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state: { selectRows: unknown[]; updates: Array<Record<string, unknown>> } = { selectRows: [], updates: [] };
function chain(result: () => unknown): any {
  const p: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(result()).then(res, rej);
      if (prop === 'catch') return (fn: (e: unknown) => void) => Promise.resolve(result()).catch(fn);
      return () => p;
    },
    apply() { return p; },
  });
  return p;
}
vi.mock('../../db/index.js', () => ({
  db: {
    select: () => chain(() => state.selectRows),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.updates.push(v);
        return chain(() => []);
      },
    }),
    insert: () => chain(() => []),
    execute: async () => undefined,
  },
}));

const liveUsers = new Set<number>();
vi.mock('../../services/liveMeetingGrace.js', async (orig) => {
  const actual = await orig<typeof import('../../services/liveMeetingGrace.js')>();
  return { ...actual, hasLiveMeeting: vi.fn(async (userId: number) => liveUsers.has(userId)) };
});

import { isLiveMeeting, applyLiveMeetingGrace, LIVE_MEETING_STALE_HOURS } from '../../services/liveMeetingGrace.js';
import { findActiveToken, isTokenActive, tokenExpiryInfo } from '../../services/apiTokenService.js';
import { authenticateToken } from '../tokenAuth.js';
import { sessionInvalidReason } from '../sessionPolicy.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const env = { ...process.env };

function tokenRow(opts: { createdDaysAgo: number; lastUsedDaysAgo: number; revoked?: boolean; userId?: number }, now = Date.now()) {
  return {
    tokenId: 11,
    userId: opts.userId ?? 42,
    lastUsedAt: new Date(now - opts.lastUsedDaysAgo * DAY),
    createdAt: new Date(now - opts.createdDaysAgo * DAY),
    revokedAt: opts.revoked ? new Date(now - HOUR) : null,
    deviceName: '会議室のノートPC',
    clientType: 'desktop',
    email: 'a@example.com',
    displayName: '山田',
  };
}

beforeEach(() => {
  state.selectRows = [];
  state.updates = [];
  liveUsers.clear();
  delete process.env.TOKEN_IDLE_DAYS;
  delete process.env.TOKEN_ABSOLUTE_DAYS;
});
afterEach(() => { process.env = { ...env }; });

describe('isLiveMeeting と applyLiveMeetingGrace', () => {
  const now = Date.now();
  it('録音中または一時停止中で最近の動きがあれば true を返す', () => {
    expect(isLiveMeeting({ status: 'active', lastAudioAt: new Date(now - 60_000) }, now)).toBe(true);
    expect(isLiveMeeting({ status: 'paused', lastAudioAt: new Date(now - 2 * HOUR) }, now)).toBe(true);
    expect(isLiveMeeting({ status: 'active', lastAudioAt: null, startedAt: new Date(now - HOUR) }, now)).toBe(true);
  });
  it('未開始と終了済みの会議は false を返す', () => {
    expect(isLiveMeeting({ status: 'idle', startedAt: new Date(now) }, now)).toBe(false);
    expect(isLiveMeeting({ status: 'completed', lastAudioAt: new Date(now) }, now)).toBe(false);
  });
  it('一時停止のまま一定時間を過ぎた会議は false を返す', () => {
    const stale = new Date(now - (LIVE_MEETING_STALE_HOURS * HOUR + 1));
    expect(isLiveMeeting({ status: 'paused', lastAudioAt: stale }, now)).toBe(false);
    expect(isLiveMeeting({ status: 'paused', lastAudioAt: new Date(now - 7 * HOUR) }, now)).toBe(true);
  });
  it('applyLiveMeetingGrace は期限切れと会議の有無から結果を返す', () => {
    expect(applyLiveMeetingGrace(false, false)).toBe('valid');
    expect(applyLiveMeetingGrace(true, true)).toBe('grace');
    expect(applyLiveMeetingGrace(true, false)).toBe('expired');
  });
});

describe('会議中のトークンの期限', () => {
  it('会議中は発行からの期限を過ぎても有効とし、無効の記録もしない', async () => {
    liveUsers.add(42);
    state.selectRows = [tokenRow({ createdDaysAgo: 90.01, lastUsedDaysAgo: 0.01 })];
    const t = await findActiveToken('x'.repeat(64));
    expect(t).not.toBeNull();
    expect(t!.inLiveMeetingGrace).toBe(true);
    expect(state.updates.some((u) => 'revokedAt' in u)).toBe(false);
  });

  it('会議中は使われない期間の上限を過ぎても有効とする', async () => {
    liveUsers.add(42);
    state.selectRows = [tokenRow({ createdDaysAgo: 40, lastUsedDaysAgo: 30.5 })];
    const t = await findActiveToken('x'.repeat(64));
    expect(t).not.toBeNull();
    expect(state.updates.some((u) => 'revokedAt' in u)).toBe(false);
  });

  it('会議中は期限切れのトークンでも接続の認証が通る', async () => {
    liveUsers.add(42);
    state.selectRows = [tokenRow({ createdDaysAgo: 91, lastUsedDaysAgo: 0.2 })];
    const user = await authenticateToken('y'.repeat(64));
    expect(user).toEqual({ userId: 42, email: 'a@example.com', displayName: '山田', tokenId: 11 });
  });

  it('会議が無ければ期限切れのトークンを無効にして記録する', async () => {
    state.selectRows = [tokenRow({ createdDaysAgo: 91, lastUsedDaysAgo: 0.2 })];
    expect(await findActiveToken('x'.repeat(64))).toBeNull();
    expect(await authenticateToken('x'.repeat(64))).toBeNull();
    expect(state.updates.some((u) => u.revokedReason === 'idle_expired')).toBe(true);
  });

  it('取り消されたトークンは会議中でも無効とする', async () => {
    liveUsers.add(42);
    state.selectRows = [tokenRow({ createdDaysAgo: 1, lastUsedDaysAgo: 0, revoked: true })];
    expect(await findActiveToken('x'.repeat(64))).toBeNull();
  });

  it('期限内のトークンは有効で、猶予の印は付けない', async () => {
    state.selectRows = [tokenRow({ createdDaysAgo: 10, lastUsedDaysAgo: 0.5 })];
    const t = await findActiveToken('x'.repeat(64));
    expect(t).not.toBeNull();
    expect(t!.inLiveMeetingGrace).toBeUndefined();
  });

  it('isTokenActive も会議の有無と取り消しの有無に従う', async () => {
    liveUsers.add(42);
    state.selectRows = [tokenRow({ createdDaysAgo: 91, lastUsedDaysAgo: 0 })];
    expect(await isTokenActive(901)).toBe(true);
    liveUsers.clear();
    expect(await isTokenActive(902)).toBe(false);
    state.selectRows = [tokenRow({ createdDaysAgo: 1, lastUsedDaysAgo: 0, revoked: true })];
    liveUsers.add(42);
    expect(await isTokenActive(903)).toBe(false);
  });
});

describe('会議中のセッションの最長期間', () => {
  const abs = 720 * 60 * 1000;
  const now = Date.now();
  it('最長期間を過ぎても会議中なら有効、会議が無ければ無効と判定する', () => {
    const s = { userId: 1, issuedAt: now - abs - 1 };
    expect(sessionInvalidReason(s, now, { absoluteMs: abs, tokenActive: null, hasLiveMeeting: true })).toBeNull();
    expect(sessionInvalidReason(s, now, { absoluteMs: abs, tokenActive: null, hasLiveMeeting: false })).toBe('absolute_expired');
  });
  it('元のトークンが取り消されていれば会議中でも無効と判定する', () => {
    const s = { userId: 1, issuedAt: now - abs - 1, apiTokenId: 3 };
    expect(sessionInvalidReason(s, now, { absoluteMs: abs, tokenActive: false, hasLiveMeeting: true })).toBe('token_revoked');
  });
});

describe('tokenExpiryInfo', () => {
  it('期限の日時と残りの日数を返す', () => {
    const now = Date.UTC(2001, 5, 1);
    const created = new Date(now - 80 * DAY);
    const info = tokenExpiryInfo(new Date(now - HOUR), created, now, 30, 90);
    expect(info.tokenExpiresAt).toBe(new Date(created.getTime() + 90 * DAY).toISOString());
    expect(info.daysUntilReauth).toBe(10);
    expect(info.tokenIdleExpiresAt).toBe(new Date(now - HOUR + 30 * DAY).toISOString());
  });
  it('期限が無い設定なら null、期限を過ぎていれば残りは 0 日を返す', () => {
    const now = Date.now();
    expect(tokenExpiryInfo(new Date(now), new Date(now - 100 * DAY), now, 30, 0)).toMatchObject({ tokenExpiresAt: null, daysUntilReauth: null });
    expect(tokenExpiryInfo(new Date(now), new Date(now - 100 * DAY), now, 30, 90).daysUntilReauth).toBe(0);
  });
});
