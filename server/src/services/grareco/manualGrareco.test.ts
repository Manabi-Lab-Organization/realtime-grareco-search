import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const buildGrarecoDraft = vi.fn(async (_input: unknown) => {
  throw new Error('draft failed (test)');
});
vi.mock('../geminiService.js', () => ({
  rebuildStructuredSummary: vi.fn(),
  consolidateSummaryThemes: vi.fn(),
  generateStructuredSummary: vi.fn(),
}));
vi.mock('./finalDraft.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./finalDraft.js')>()),
  buildGrarecoDraft: (input: unknown) => buildGrarecoDraft(input),
}));
import { isPromptDropped, flareCostUsd, PromptDroppedError } from './openaiImage.js';
import { generateManualGrareco, manualGrarecoProvider } from './manualGrareco.js';
import { grarecoRefImageCount, geminiImageCostUsd } from './imageOutput.js';
import type { GrarecoImageResult } from './imageOutput.js';

const savedOpenAIKey = process.env.OPENAI_API_KEY;
beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

afterEach(() => {
  if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAIKey;
  delete process.env.GRARECO_MANUAL_PROVIDER;
  delete process.env.GRARECO_REF_IMAGES;
  vi.restoreAllMocks();
});

describe('isPromptDropped と PromptDroppedError', () => {
  it('入力トークン数が極端に少ないと指示が失われたと判定する', () => {
    expect(isPromptDropped(8)).toBe(true);
  });

  it('十分な入力トークン数では失われたと判定しない', () => {
    for (const n of [2500, 4000, 6000, 9000]) expect(isPromptDropped(n)).toBe(false);
  });

  it('入力トークン数が無いときは失われたと判定しない', () => {
    expect(isPromptDropped(undefined)).toBe(false);
  });

  it('PromptDroppedError はトークン数と指示の長さを持つ', () => {
    const e = new PromptDroppedError(8, 10000);
    expect(e.inputTokens).toBe(8);
    expect(e.promptLength).toBe(10000);
    expect(e.name).toBe('PromptDroppedError');
  });
});

describe('料金の見積もり', () => {
  it('flareCostUsd は入力と出力のトークン数から金額を求める', () => {
    expect(flareCostUsd(2000, 3000)).toBeCloseTo(0.1, 3);
  });

  it('geminiImageCostUsd は画像とテキストの出力を分けて金額を求める', () => {
    const cost = geminiImageCostUsd({ promptTokenCount: 2000, candidatesTokenCount: 2000, imageTokenCount: 1120 });
    expect(cost).toBeCloseTo(0.0708, 3);
  });

  it('出力をすべて画像として数えた場合より小さくなる', () => {
    const correct = geminiImageCostUsd({ promptTokenCount: 2000, candidatesTokenCount: 2000, imageTokenCount: 1120 })!;
    const wrong = (2000 * 60) / 1_000_000;
    expect(correct).toBeLessThan(wrong);
  });

  it('トークン数が無ければ undefined を返す', () => {
    expect(geminiImageCostUsd(undefined)).toBeUndefined();
    expect(geminiImageCostUsd({})).toBeUndefined();
  });
});

describe('grarecoRefImageCount', () => {
  it('設定が無ければ 0 を返す', () => {
    expect(grarecoRefImageCount()).toBe(0);
  });

  it('設定した枚数を返す', () => {
    process.env.GRARECO_REF_IMAGES = '4';
    expect(grarecoRefImageCount()).toBe(4);
  });

  it('数として正しくない値は 0 にする', () => {
    for (const v of ['abc', '-1', '']) {
      process.env.GRARECO_REF_IMAGES = v;
      expect(grarecoRefImageCount()).toBe(0);
    }
  });
});

describe('generateManualGrareco の作り方の選択と切り替え', () => {
  const geminiResult: GrarecoImageResult = {
    imageUrl: 'data:image/png;base64,AAAA',
    modelUsed: 'gemini-3.1-flash-image',
    costUsd: 0.08,
    refImagesUsed: 0,
    attempt: 1,
  };

  it('設定が無ければ openai を選ぶ', () => {
    expect(manualGrarecoProvider()).toBe('openai');
  });

  it('OpenAI のキーが無ければ gemini を選ぶ', () => {
    delete process.env.OPENAI_API_KEY;
    expect(manualGrarecoProvider()).toBe('gemini');
  });

  it('設定で gemini を指定するとそちらだけを使う', async () => {
    process.env.GRARECO_MANUAL_PROVIDER = 'gemini';
    expect(manualGrarecoProvider()).toBe('gemini');
    const gemini = vi.fn().mockResolvedValue(geminiResult);
    const out = await generateManualGrareco('新商品の企画会議のまとめ', undefined, gemini);
    expect(gemini).toHaveBeenCalledOnce();
    expect(out.modelUsed).toBe('gemini-3.1-flash-image');
    expect(out.fallbackReason).toBeUndefined();
  });

  it('下書きには要約・全文・開催日を渡し、切り替え先には短くした本文を渡す', async () => {
    const gemini = vi.fn().mockResolvedValue(geminiResult);
    await generateManualGrareco('展示会の準備（短縮版）', undefined, gemini, {
      summary: '## 1. 展示会の準備 [00:00-01:00]\n・ブースの配置を決めた',
      material: '展示会の準備についての発言の全文',
      meetingDate: new Date('2001-03-02T23:30:00Z'),
    });
    expect(buildGrarecoDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: '## 1. 展示会の準備 [00:00-01:00]\n・ブースの配置を決めた',
        pasted: '展示会の準備についての発言の全文',
        material: expect.stringContaining('展示会の準備についての発言の全文'),
        meetingDate: '2001年3月3日（土）',
      }),
    );
    expect(gemini).toHaveBeenCalledWith('展示会の準備（短縮版）', undefined);
  });

  it('下書きに失敗したら gemini に切り替え、理由を結果に残す', async () => {
    const gemini = vi.fn().mockResolvedValue(geminiResult);
    const out = await generateManualGrareco('新商品の企画会議のまとめ', undefined, gemini);
    expect(gemini).toHaveBeenCalledOnce();
    expect(out.imageUrl).toBe(geminiResult.imageUrl);
    expect(out.fallbackReason).toContain('draft failed');
  });
});
