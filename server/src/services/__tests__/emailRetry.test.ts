import { describe, it, expect } from 'vitest';
import { isTransientMailError } from '../emailService.js';

describe('isTransientMailError', () => {
  it('ステータスコードの無い通信エラーは一時的な失敗とみなす', () => {
    expect(isTransientMailError({
      name: 'application_error', statusCode: null,
      message: 'Network request failed before a response was received.',
    })).toBe(true);
    expect(isTransientMailError({ message: 'timeout' })).toBe(true);
  });

  it('408・429・5xx は一時的な失敗とみなす', () => {
    for (const statusCode of [408, 429, 500, 502, 503, 529]) {
      expect(isTransientMailError({ statusCode })).toBe(true);
    }
  });

  it('上記以外の 4xx は一時的な失敗とみなさない', () => {
    for (const statusCode of [400, 401, 403, 404, 422]) {
      expect(isTransientMailError({ statusCode })).toBe(false);
    }
  });

  it('エラーが無いときは false を返す', () => {
    expect(isTransientMailError(null)).toBe(false);
    expect(isTransientMailError(undefined)).toBe(false);
  });
});
