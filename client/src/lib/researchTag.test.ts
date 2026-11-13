import { describe, expect, it } from 'vitest';
import { researchCardTag, researchCardTagText } from './researchTag';
import { formatResearchForCopy, researchCardLabel } from './publicShare';

describe('researchCardTag（調査カードの札）', () => {
  it('参考になる情報は、書いた調査役の名前を出す', () => {
    expect(researchCardTag({ cardType: 'info', agentType: 'tech' })).toEqual({ icon: '🔧', label: '技術情報', tone: 'info' });
    expect(researchCardTag({ cardType: 'info', agentType: 'web' }).label).toBe('補足情報');
  });
  it('事実確認・論理課題は、書いた調査役に関係なく種類の名前を出す', () => {
    expect(researchCardTag({ cardType: 'fact-check', agentType: 'tech' }).label).toBe('事実確認');
    expect(researchCardTag({ cardType: 'gap-alert', agentType: 'web' }).label).toBe('論理課題');
  });
  it('調査役が分からないカードは「参考情報」', () => {
    expect(researchCardTag({ cardType: 'info', agentType: 'unknown' }).label).toBe('参考情報');
    expect(researchCardTag({ cardType: 'info' }).label).toBe('参考情報');
  });
  it('コピーと共有ページも同じ札になる', () => {
    const card = { cardType: 'info', agentType: 'tech' };
    expect(researchCardTagText(card)).toBe('🔧技術情報');
    expect(researchCardLabel(card)).toBe('🔧技術情報');
    const text = formatResearchForCopy({ ...card, keyword: '表計算ソフト', title: 't', body: 'b', sources: [] } as never);
    expect(text.startsWith('【🔧技術情報】 表計算ソフト')).toBe(true);
  });
});
