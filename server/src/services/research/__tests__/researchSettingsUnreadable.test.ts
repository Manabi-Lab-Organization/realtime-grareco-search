import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = vi.hoisted(() => ({ rows: [] as unknown[], fail: false }));

vi.mock('../../../db/index.js', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) =>
      prop === 'then'
        ? (resolve: (rows: unknown[]) => void, reject: (e: unknown) => void) =>
            dbState.fail ? reject(new Error('db down')) : resolve(dbState.rows)
        : () => chain,
    apply: () => chain,
  });
  return { db: chain, pool: {} };
});

const { fetchUserResearchSettings, fetchUserResearchSettingsIfReadable } = await import('../managedAgent.js');

beforeEach(() => {
  dbState.rows = [];
  dbState.fail = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('リアルタイム調査の設定を読めないとき', () => {
  it('利用者が見つからなければ調査を止めた状態として扱い、画面へは送らない', async () => {
    expect((await fetchUserResearchSettings(1)).main).toBe(false);
    expect(await fetchUserResearchSettingsIfReadable(1)).toBeNull();
  });

  it('データベースの読み込みに失敗しても調査を止めた状態として扱い、画面へは送らない', async () => {
    dbState.fail = true;
    expect((await fetchUserResearchSettings(1)).main).toBe(false);
    expect(await fetchUserResearchSettingsIfReadable(1)).toBeNull();
  });

  it('読めたときは保存された設定を使い、欠けた項目は既定で補う', async () => {
    dbState.rows = [{ researchSettings: { main: true } }];
    const s = await fetchUserResearchSettings(1);
    expect(s.main).toBe(true);
    expect(await fetchUserResearchSettingsIfReadable(1)).toEqual(s);
    dbState.rows = [{ researchSettings: { main: false } }];
    expect((await fetchUserResearchSettings(1)).main).toBe(false);
  });
});

describe('接続したときの設定の送信', () => {
  it('読めたときだけ送る', async () => {
    const { readFileSync } = await import('node:fs');
    for (const rel of ['../../../websocket/socketIO.ts', '../../../websocket/nativeWs.ts']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      expect(src).toContain('await fetchUserResearchSettingsIfReadable(');
      expect(src).not.toMatch(/await fetchUserResearchSettings\(/);
    }
  });
});
