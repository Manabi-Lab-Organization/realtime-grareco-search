import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { isUniqueViolation, stripQueryParams } from '../queryError.js';

function pgError(code: string): Error {
  return Object.assign(new Error('pg error'), { code });
}

describe('isUniqueViolation', () => {
  it('クエリの失敗に包まれた一意制約違反を見分ける', () => {
    const err = new DrizzleQueryError('insert', ['value'], pgError('23505'));
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('包まれていない一意制約違反も見分ける', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
  });

  it('ほかの失敗は一意制約違反としない', () => {
    expect(isUniqueViolation(new DrizzleQueryError('insert', [], pgError('23503')))).toBe(false);
    expect(isUniqueViolation(new Error('other'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('stripQueryParams', () => {
  it('クエリの失敗からは元の失敗だけを返す', () => {
    const cause = pgError('23505');
    const err = new DrizzleQueryError('update', ['secret-value'], cause);
    expect(stripQueryParams(err)).toBe(cause);
  });

  it('元の失敗が無くてもパラメータを含まない', () => {
    const err = new DrizzleQueryError('update', ['secret-value']);
    const stripped = stripQueryParams(err);
    expect(stripped.message).not.toContain('secret-value');
    expect(stripped.stack).not.toContain('secret-value');
  });

  it('ほかの失敗はそのまま返す', () => {
    const err = new Error('other');
    expect(stripQueryParams(err)).toBe(err);
  });
});
