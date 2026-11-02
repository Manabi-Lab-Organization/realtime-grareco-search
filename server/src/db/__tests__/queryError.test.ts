import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { DB_FAILURE_MESSAGE, isUniqueViolation, publicErrorMessage, stripQueryParams } from '../queryError.js';

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

describe('publicErrorMessage', () => {
  it('クエリの失敗には、SQL・パラメータ・元の失敗の文を含まない固定の文を返す', () => {
    const cause = new Error('invalid input syntax: "cause-value"');
    const err = new DrizzleQueryError('select "secret_column" from "users"', ['secret-value'], cause);
    const text = publicErrorMessage(err);
    expect(text).toBe(DB_FAILURE_MESSAGE);
    expect(text).not.toContain('secret_column');
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('cause-value');
  });

  it('元の失敗が無いクエリの失敗にも固定の文を返す', () => {
    expect(publicErrorMessage(new DrizzleQueryError('select 1', []))).toBe(DB_FAILURE_MESSAGE);
  });

  it('ほかの失敗は今の文のまま返す', () => {
    expect(publicErrorMessage(new Error('meeting_not_found'))).toBe('meeting_not_found');
  });

  it('Error でない値は文字列にして返す', () => {
    expect(publicErrorMessage('plain text')).toBe('plain text');
    expect(publicErrorMessage(undefined)).toBe('undefined');
  });
});
