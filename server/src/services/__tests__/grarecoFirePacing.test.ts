import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { BASE_MIN_AUTO_INTERVAL_MS, isInFireCooldown, minAutoFireIntervalMs } from '../grareco/firePacing.js';

const MIN = 60 * 1000;
const auto = (maxImagesPerHour: number) => ({ autoPromoteMode: 'auto' as const, maxImagesPerHour });

describe('自動グラレコを作る間隔を、1 時間の画像化の上限にそろえる', () => {
  it('上限 6 枚なら 10 分、7 枚なら約 8 分 34 秒', () => {
    expect(minAutoFireIntervalMs(auto(6))).toBe(10 * MIN);
    expect(minAutoFireIntervalMs(auto(7))).toBe(Math.ceil((60 * MIN) / 7));
  });

  it('上限 12 枚以上は 5 分より詰めない', () => {
    expect(minAutoFireIntervalMs(auto(12))).toBe(BASE_MIN_AUTO_INTERVAL_MS);
    expect(minAutoFireIntervalMs(auto(30))).toBe(BASE_MIN_AUTO_INTERVAL_MS);
  });

  it('上限 1 枚なら 60 分', () => {
    expect(minAutoFireIntervalMs(auto(1))).toBe(60 * MIN);
  });

  it('確認してから画像にする設定では、上限に関係なく 5 分', () => {
    expect(minAutoFireIntervalMs({ autoPromoteMode: 'manual', maxImagesPerHour: 3 })).toBe(BASE_MIN_AUTO_INTERVAL_MS);
  });

  it('上限の値が壊れていたら 5 分にする', () => {
    expect(minAutoFireIntervalMs(auto(0))).toBe(BASE_MIN_AUTO_INTERVAL_MS);
    expect(minAutoFireIntervalMs(auto(Number.NaN))).toBe(BASE_MIN_AUTO_INTERVAL_MS);
    expect(minAutoFireIntervalMs(auto(undefined as unknown as number))).toBe(BASE_MIN_AUTO_INTERVAL_MS);
  });

  it('この間隔で作り続けても、どの 1 時間を切り取っても上限を超えない', () => {
    for (let limit = 1; limit <= 30; limit++) {
      const interval = minAutoFireIntervalMs(auto(limit));
      expect(Math.ceil((60 * MIN) / interval)).toBeLessThanOrEqual(limit);
    }
  });
});

describe('isInFireCooldown', () => {
  const now = 1_800_000_000_000;

  it('一度も作っていなければ待たない', () => {
    expect(isInFireCooldown(0, now, auto(7))).toBe(false);
  });

  it('上限 7 枚：前回から 6 分では待ち、9 分なら作れる', () => {
    expect(isInFireCooldown(now - 6 * MIN, now, auto(7))).toBe(true);
    expect(isInFireCooldown(now - 9 * MIN, now, auto(7))).toBe(false);
  });
});

describe('作るきっかけの 3 つの経路が、同じ間隔の判定を通る', () => {
  const src = readFileSync(new URL('../grareco/autoGrarecoOrchestrator.ts', import.meta.url), 'utf-8');

  it('固定の 5 分の定数を直接使っていない', () => {
    expect(src).not.toMatch(/MIN_AUTO_INTERVAL_MS/);
  });

  it('話題やセクションの切り替わり、沈黙、時間切れのそれぞれで判定している', () => {
    const body = (name: string) => {
      const start = src.indexOf(name);
      expect(start).toBeGreaterThan(-1);
      return src.slice(start, start + 1200);
    };
    expect(body('export async function processFinalTranscript')).toMatch(/isInFireCooldown\(/);
    expect(body('shouldFireDiscover: async')).toMatch(/isInFireCooldown\(/);
    expect(body('shouldFireFallback: async')).toMatch(/isInFireCooldown\(/);
  });
});
