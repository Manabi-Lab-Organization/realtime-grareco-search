import { describe, it, expect } from 'vitest';
import { sanitizeResearchSources } from '../sources.js';

describe('sanitizeResearchSources', () => {
  it('http と https の URL を持つ項目だけを残す', () => {
    const out = sanitizeResearchSources([
      { url: 'https://example.com/a', title: 'サンプル記事', trustScore: 0.9 },
      { url: 'javascript:alert(document.cookie)', title: 'bad1' },
      { url: 'data:text/html,<script>alert(1)</script>', title: 'bad2' },
      { url: 'java\nscript:alert(1)', title: 'bad3' },
      { url: 'http://example.org', title: '参考ページ' },
      { url: '', title: 'empty' },
      { title: 'no url' },
    ]);
    expect(out.map((s) => s.url)).toEqual(['https://example.com/a', 'http://example.org']);
    expect(out[0].trustScore).toBe(0.9);
    expect(out[1].trustScore).toBe(0.5);
  });

  it('配列以外や不正な要素だけの入力では空配列を返す', () => {
    expect(sanitizeResearchSources(undefined)).toEqual([]);
    expect(sanitizeResearchSources('https://example.com')).toEqual([]);
    expect(sanitizeResearchSources([null, 1, 'x'])).toEqual([]);
  });

  it('型の合わない title と trustScore は既定値に置き換える', () => {
    const [s] = sanitizeResearchSources([{ url: 'https://example.com', title: { x: 1 }, trustScore: 'high' }]);
    expect(s.title).toBe('');
    expect(s.trustScore).toBe(0.5);
  });
});
