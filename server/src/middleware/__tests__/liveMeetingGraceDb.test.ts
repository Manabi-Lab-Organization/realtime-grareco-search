import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: { rows: unknown[]; fail: boolean; calls: number } = { rows: [], fail: false, calls: 0 };
const q: any = {
  from: () => q, where: () => q, orderBy: () => q,
  limit: async () => { state.calls++; if (state.fail) throw new Error('db down'); return state.rows; },
};
vi.mock('../../db/index.js', () => ({ db: { select: () => q } }));

import { hasLiveMeeting, clearLiveMeetingCache } from '../../services/liveMeetingGrace.js';

const HOUR = 60 * 60 * 1000;
beforeEach(() => { state.rows = []; state.fail = false; state.calls = 0; clearLiveMeetingCache(); });

describe('hasLiveMeeting', () => {
  it('音声を受け取っている会議があれば true を返す', async () => {
    const now = Date.now();
    state.rows = [{ status: 'active', lastAudioAt: new Date(now - 1000), transcriptionStartedAt: null, startedAt: new Date(now - HOUR) }];
    expect(await hasLiveMeeting(1, now)).toBe(true);
  });
  it('長時間止まったままの一時停止中の会議だけなら false を返す', async () => {
    const now = Date.now();
    state.rows = [{ status: 'paused', lastAudioAt: new Date(now - 13 * HOUR), transcriptionStartedAt: null, startedAt: new Date(now - 20 * HOUR) }];
    expect(await hasLiveMeeting(2, now)).toBe(false);
  });
  it('データベースの読み込みに失敗したら false を返す', async () => {
    state.fail = true;
    expect(await hasLiveMeeting(3)).toBe(false);
  });
  it('続けて呼ぶと前の結果を使い回す', async () => {
    const now = Date.now();
    await hasLiveMeeting(4, now);
    await hasLiveMeeting(4, now + 1000);
    expect(state.calls).toBe(1);
  });
});
