import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_LIGHT_MODEL,
  GRARECO_DETECTION_MODEL,
  THINKING_HEADROOM_TOKENS,
  lightRequestParams,
  logIfRefused,
} from './lightModel.js';
import { acceptsTemperature } from './modelSupport.js';
import { estimateCostUsd } from '../llmCost.js';

describe('軽い処理のモデル', () => {
  it('既定は claude-haiku-5-5、グラレコの区切りの判定は Haiku 4.5 のまま', () => {
    expect(DEFAULT_LIGHT_MODEL).toBe('claude-haiku-5-5');
    expect(GRARECO_DETECTION_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('Haiku 5.5 には考える分の余裕を足し、effort low を送り、temperature は送らない', () => {
    const p = lightRequestParams('claude-haiku-5-5', { maxTokens: 1000, temperature: 0.3 });
    expect(p.max_tokens).toBe(1000 + THINKING_HEADROOM_TOKENS);
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.temperature).toBeUndefined();
  });

  it('Haiku 4.5 に戻したときは effort を送らず、temperature を送る', () => {
    const p = lightRequestParams('claude-haiku-4-5-20251001', { maxTokens: 1000, temperature: 0.3 });
    expect(p.max_tokens).toBe(1000);
    expect(p.output_config).toBeUndefined();
    expect(p.temperature).toBe(0.3);
  });

  it('temperature は 4.6 世代以前のモデルにだけ送る', () => {
    expect(acceptsTemperature('claude-sonnet-4-6')).toBe(true);
    expect(acceptsTemperature('claude-haiku-4-5-20251001')).toBe(true);
    expect(acceptsTemperature('claude-opus-4-7')).toBe(false);
    expect(acceptsTemperature('claude-sonnet-5-5')).toBe(false);
    expect(acceptsTemperature('claude-haiku-5-5')).toBe(false);
  });

  it('断られたときはログに残す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(logIfRefused({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }, 'agent', 'claude-haiku-5-5')).toBe(true);
    expect(warn.mock.calls[0][0]).toContain('category=cyber');
    expect(logIfRefused({ stop_reason: 'end_turn', stop_details: null }, 'agent', 'claude-haiku-5-5')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('原価の単価表に Haiku 5.5 がある', () => {
    expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(estimateCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBeCloseTo(6);
  });
});
