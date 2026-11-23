import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({
  json: vi.fn(),
  text: vi.fn(),
}));

vi.mock('../anthropicService.js', () => ({
  analyzeWithClaudeJson: calls.json,
  analyzeWithClaude: calls.text,
}));

import {
  GRARECO_DRAFT_MODEL_DEFAULT,
  GRARECO_DRAFT_SCHEMA,
  grarecoDraftModel,
  grarecoDraftUsesJsonSchema,
  requestGrarecoDraftText,
} from '../grareco/draftRequest.js';
import { GRARECO_DETECTION_MODEL } from '../llm/lightModel.js';

beforeEach(() => {
  calls.json.mockReset();
  calls.text.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('自動グラレコの下書きのモデルと頼み方', () => {
  it('既定は claude-haiku-5-5 で、判定のモデルとは別に決める', () => {
    expect(GRARECO_DRAFT_MODEL_DEFAULT).toBe('claude-haiku-5-5');
    expect(grarecoDraftModel({})).toBe('claude-haiku-5-5');
    expect(grarecoDraftModel({ GRARECO_DRAFT_MODEL: ' claude-haiku-4-5-20251001 ' })).toBe('claude-haiku-4-5-20251001');
    expect(GRARECO_DETECTION_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('答えの形の指定は既定で使い、off・false・0 で切る', () => {
    expect(grarecoDraftUsesJsonSchema({})).toBe(true);
    expect(grarecoDraftUsesJsonSchema({ GRARECO_DRAFT_JSON_SCHEMA: 'on' })).toBe(true);
    for (const v of ['off', 'OFF', 'false', '0']) {
      expect(grarecoDraftUsesJsonSchema({ GRARECO_DRAFT_JSON_SCHEMA: v })).toBe(false);
    }
  });

  it('形の決まり：どの object も余分な項目を許さず、下書きの読み取りに要る項目を必須にする', () => {
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') expect(node.additionalProperties).toBe(false);
      for (const v of Object.values(node)) walk(v);
    };
    walk(GRARECO_DRAFT_SCHEMA);
    expect(GRARECO_DRAFT_SCHEMA.required).toEqual(['title', 'sections', 'highlights', 'researchRefs', 'visualStyle']);
  });

  it('形を指定して頼み、答えをそのまま返す', async () => {
    calls.json.mockResolvedValue({ text: '{"title":"A"}', stopReason: 'end_turn' });
    expect(await requestGrarecoDraftText('s', 'u', {})).toBe('{"title":"A"}');
    expect(calls.json).toHaveBeenCalledWith('s', 'u', GRARECO_DRAFT_SCHEMA, expect.objectContaining({ model: 'claude-haiku-5-5', maxTokens: 2048 }));
    expect(calls.text).not.toHaveBeenCalled();
  });

  it.each([
    ['失敗した', () => calls.json.mockRejectedValue(new Error('400'))],
    ['途中で切れた', () => calls.json.mockResolvedValue({ text: '{"title"', stopReason: 'max_tokens' })],
    ['空だった', () => calls.json.mockResolvedValue({ text: '', stopReason: 'end_turn' })],
  ])('形を指定した呼び出しが%sときは、指示文だけでやり直す', async (_name, arrange) => {
    arrange();
    calls.text.mockResolvedValue('{"title":"B"}');
    expect(await requestGrarecoDraftText('s', 'u', {})).toBe('{"title":"B"}');
    expect(calls.text).toHaveBeenCalledWith('s', 'u', expect.objectContaining({ model: 'claude-haiku-5-5', effort: 'low', maxTokens: 2048 }));
  });

  it('形の指定を切ったときは、指示文だけで頼む', async () => {
    calls.text.mockResolvedValue('{"title":"C"}');
    const env = { GRARECO_DRAFT_JSON_SCHEMA: 'off', GRARECO_DRAFT_MODEL: 'claude-haiku-4-5-20251001' };
    expect(await requestGrarecoDraftText('s', 'u', env)).toBe('{"title":"C"}');
    expect(calls.json).not.toHaveBeenCalled();
    expect(calls.text).toHaveBeenCalledWith('s', 'u', expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }));
  });
});
