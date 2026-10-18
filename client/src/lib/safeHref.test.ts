import { describe, it, expect } from 'vitest';
import { safeHref } from './safeHref';

describe('safeHref', () => {
  it('http と https の URL は変えずに返す', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com');
  });

  it('危険なスキームの URL には undefined を返す', () => {
    for (const u of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(safeHref(u), u).toBeUndefined();
    }
  });

  it('制御文字や空白を挟んだスキームにも undefined を返す', () => {
    expect(safeHref('java\nscript:alert(1)')).toBeUndefined();
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined();
    expect(safeHref('\u0001javascript:alert(1)')).toBeUndefined();
  });

  it('相対パス・空文字・null・undefined には undefined を返す', () => {
    expect(safeHref('/relative')).toBeUndefined();
    expect(safeHref('')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});
