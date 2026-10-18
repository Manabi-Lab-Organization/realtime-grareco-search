import { describe, it, expect } from 'vitest';
import { httpUrlOrNull, isHttpUrl } from '../urlSafety.js';

describe('httpUrlOrNull', () => {
  it('http と https の URL は前後の空白を除いて返す', () => {
    expect(httpUrlOrNull('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(httpUrlOrNull('http://example.com')).toBe('http://example.com');
    expect(httpUrlOrNull('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('危険なスキームの URL には null を返す', () => {
    expect(httpUrlOrNull('javascript:alert(1)')).toBeNull();
    expect(httpUrlOrNull('JavaScript:alert(1)')).toBeNull();
    expect(httpUrlOrNull('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(httpUrlOrNull('vbscript:msgbox(1)')).toBeNull();
    expect(httpUrlOrNull('file:///etc/passwd')).toBeNull();
  });

  it('制御文字・改行・空白を含む URL には null を返す', () => {
    expect(httpUrlOrNull('java\nscript:alert(1)')).toBeNull();
    expect(httpUrlOrNull('java\tscript:alert(1)')).toBeNull();
    expect(httpUrlOrNull('\x01https://example.com')).toBeNull();
    expect(httpUrlOrNull(' javascript:alert(1)')).toBeNull();
    expect(httpUrlOrNull('https://example.com/a b')).toBeNull();
  });

  it('空文字・文字列以外・URL として読めない値には null を返す', () => {
    expect(httpUrlOrNull('')).toBeNull();
    expect(httpUrlOrNull('   ')).toBeNull();
    expect(httpUrlOrNull(null)).toBeNull();
    expect(httpUrlOrNull(undefined)).toBeNull();
    expect(httpUrlOrNull(123)).toBeNull();
    expect(httpUrlOrNull('/relative/path')).toBeNull();
    expect(httpUrlOrNull('example.com')).toBeNull();
  });

  it('isHttpUrl は判定結果を真偽値で返す', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  });
});
