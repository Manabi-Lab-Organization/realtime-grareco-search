import { describe, it, expect } from 'vitest';
import { apiErrorText } from './apiError';

describe('apiErrorText', () => {
  it('案内の文があれば、記号の代わりにそれを返す', () => {
    expect(apiErrorText({ error: 'in_progress', message: 'グラレコを生成中です' }, 429)).toBe('グラレコを生成中です');
    expect(apiErrorText({ error: 'cooldown', message: 'あと 10 秒待ってください' }, 429)).toBe('あと 10 秒待ってください');
  });

  it('案内の文がなければ error を返す', () => {
    expect(apiErrorText({ error: '指示は 2000 文字以内で入力してください' }, 400)).toBe('指示は 2000 文字以内で入力してください');
    expect(apiErrorText({ error: '見つかりません', message: '' }, 404)).toBe('見つかりません');
  });

  it('どちらもなければ状態の番号を返す', () => {
    expect(apiErrorText({}, 500)).toBe('HTTP 500');
    expect(apiErrorText({ error: { code: 1 } }, 502)).toBe('HTTP 502');
  });
});
