import { describe, it, expect } from 'vitest';
import { trustProxySetting } from '../../config/trustProxy.js';

describe('trustProxySetting', () => {
  it('値が無いとき、本番環境なら 1、そうでなければ false を返す', () => {
    expect(trustProxySetting(undefined, true)).toBe(1);
    expect(trustProxySetting(undefined, false)).toBe(false);
  });
  it('"false" と "0" は false を返す', () => {
    expect(trustProxySetting('false', true)).toBe(false);
    expect(trustProxySetting('0', true)).toBe(false);
  });
  it('数字は数値に変え、それ以外の文字列は真偽値または元の文字列を返す', () => {
    expect(trustProxySetting('2', true)).toBe(2);
    expect(trustProxySetting('true', true)).toBe(true);
    expect(trustProxySetting('loopback', true)).toBe('loopback');
  });
});
