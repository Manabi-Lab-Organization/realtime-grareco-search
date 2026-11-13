import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../db/index.js', () => ({ db: {}, pool: {} }));

import { ThinkingLevel } from '@google/genai';
import { observationThinkingConfig } from '../geminiService.js';

describe('環境観察の「考える量」（OBSERVATION_THINKING_LEVEL）', () => {
  it('未設定・不明な値なら何も送らない（今までどおりモデルの既定）', () => {
    expect(observationThinkingConfig({})).toEqual({});
    expect(observationThinkingConfig({ OBSERVATION_THINKING_LEVEL: '' })).toEqual({});
    expect(observationThinkingConfig({ OBSERVATION_THINKING_LEVEL: 'little' })).toEqual({});
  });

  it('minimal / low / medium / high を読む（大文字・前後の空白も許す）', () => {
    expect(observationThinkingConfig({ OBSERVATION_THINKING_LEVEL: ' Low ' })).toEqual({ thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } });
    expect(observationThinkingConfig({ OBSERVATION_THINKING_LEVEL: 'minimal' })).toEqual({ thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } });
    expect(observationThinkingConfig({ OBSERVATION_THINKING_LEVEL: 'medium' }).thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.MEDIUM);
    expect(observationThinkingConfig({ OBSERVATION_THINKING_LEVEL: 'HIGH' }).thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.HIGH);
  });

  it('画面・カメラ・360度カメラの観察と、資料のまとめの3つに効く', () => {
    const src = readFileSync(new URL('../geminiService.ts', import.meta.url), 'utf-8');
    for (const name of ['analyzeRoomObservation(', 'analyzeRoomObservationMultiView(', 'consolidateMaterials(']) {
      const start = src.indexOf(`export async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport ', start + 1);
      expect(src.slice(start, next === -1 ? undefined : next)).toContain('...observationThinkingConfig()');
    }
  });
});
