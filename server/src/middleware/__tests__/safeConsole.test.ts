import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  installSafeConsole,
  redactLogText,
  sanitizeLogArg,
  sanitizeLogError,
} from '../../logging/safeConsole.js';
import { DB_FAILURE_MESSAGE, isPgDatabaseError, publicErrorMessage } from '../../db/queryError.js';

const EMAIL = 'taro@example.com';
const TOKEN = 'tok_secret_123';

/** pg の DatabaseError と同じ形（code・severity・detail などを持つ） */
function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'error', code, severity: 'ERROR', ...extra });
}

function printed(v: unknown): string {
  return inspect(v, { depth: 10 });
}

describe('sanitizeLogError', () => {
  it('クエリの失敗から SQL とパラメータを消し、元の失敗の文と code を残す', () => {
    const cause = pgError('23505', 'duplicate key value violates unique constraint "users_email_key"', {
      detail: `Key (email)=(${EMAIL}) already exists.`,
      constraint: 'users_email_key',
    });
    const err = new DrizzleQueryError('insert into "users" ("email", "token") values ($1, $2)', [EMAIL, TOKEN], cause);
    const out = printed(sanitizeLogError(err));
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('insert into');
    expect(out).toContain('users_email_key');
    expect(out).toContain('23505');
  });

  it('クエリの失敗の呼び出し元（at 行）は残す', () => {
    const err = new DrizzleQueryError('select 1', [TOKEN]);
    const safe = sanitizeLogError(err);
    expect(safe.stack).toMatch(/\n\s+at /);
    expect(safe.stack).not.toContain(TOKEN);
  });

  it('素の pg の失敗から detail・where などを消す', () => {
    const err = pgError('23505', 'duplicate key value violates unique constraint "users_email_key"', {
      detail: `Key (email)=(${EMAIL}) already exists.`,
      where: `SQL statement "insert ... ${TOKEN}"`,
      internalQuery: `select ${TOKEN}`,
      constraint: 'users_email_key',
      table: 'users',
    });
    const safe = sanitizeLogError(err);
    const out = printed(safe);
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain(TOKEN);
    expect((safe as unknown as { table: string }).table).toBe('users');
    expect((safe as unknown as { code: string }).code).toBe('23505');
  });

  it('データの形の失敗（22xxx）は message の中の値も伏せる', () => {
    const err = pgError('22P02', `invalid input syntax for type integer: "${TOKEN}"`);
    const safe = sanitizeLogError(err);
    expect(safe.message).toBe('invalid input syntax for type integer: "…"');
    expect(printed(safe)).not.toContain(TOKEN);
  });

  it('ほかのエラーの cause に入ったクエリの失敗も消す。元のエラーは書き換えない', () => {
    const inner = new DrizzleQueryError('update "users" set "token" = $1', [TOKEN]);
    const err = new Error('保存に失敗', { cause: inner });
    const safe = sanitizeLogError(err);
    expect(printed(safe)).not.toContain(TOKEN);
    expect(safe.message).toBe('保存に失敗');
    expect(err.cause).toBe(inner);
  });

  it('`${err}` で文字列になった SQL も message・stack から消す', () => {
    const inner = new DrizzleQueryError('select * from "users" where "email" = $1', [EMAIL]);
    const err = new Error(`読み込みに失敗: ${inner.message}`);
    const out = printed(sanitizeLogError(err));
    expect(out).not.toContain(EMAIL);
    expect(out).toContain('読み込みに失敗');
  });

  it('置き換えが要らないエラーは同じものを返す', () => {
    const err = new Error('ふつうの失敗');
    expect(sanitizeLogError(err)).toBe(err);
  });
});

describe('redactLogText', () => {
  it('Failed query 以降と Key の値を伏せる', () => {
    const s = `[Billing] failed: Failed query: select 1\nparams: ${TOKEN} / Key (email)=(${EMAIL})`;
    const out = redactLogText(s);
    expect(out).toBe('[Billing] failed: Failed query: [SQL とパラメータは省略]');
    expect(redactLogText(`Key (email)=(${EMAIL}) already exists.`)).toBe('Key (email)=(…) already exists.');
  });

  it('関係ない文はそのまま', () => {
    expect(redactLogText('[Digest] 朝刊を作りました')).toBe('[Digest] 朝刊を作りました');
  });
});

describe('sanitizeLogArg', () => {
  it('{ err } の形でも中のエラーを置き換える', () => {
    const arg = { userId: 1, err: new DrizzleQueryError('select 1', [TOKEN]) };
    expect(printed(sanitizeLogArg(arg))).not.toContain(TOKEN);
  });

  it('数値や配列はそのまま', () => {
    const arr = [1, 2];
    expect(sanitizeLogArg(3)).toBe(3);
    expect(sanitizeLogArg(arr)).toBe(arr);
  });
});

describe('installSafeConsole', () => {
  it('包んだ console に渡したクエリの失敗が、SQL なしで書かれる', () => {
    const written: unknown[][] = [];
    const fake = {
      error: (...a: unknown[]) => written.push(a),
      warn: (...a: unknown[]) => written.push(a),
      log: (...a: unknown[]) => written.push(a),
      info: (...a: unknown[]) => written.push(a),
      debug: (...a: unknown[]) => written.push(a),
      trace: (...a: unknown[]) => written.push(a),
    } as unknown as Console;
    installSafeConsole(fake);
    installSafeConsole(fake); // 2 回目は何もしない
    fake.error('[Billing] 失敗:', new DrizzleQueryError('select 1', [TOKEN]));
    fake.warn(`retrying: Failed query: select 1 params: ${TOKEN}`);
    expect(written).toHaveLength(2);
    expect(printed(written)).not.toContain(TOKEN);
    expect(written[0][0]).toBe('[Billing] 失敗:');
  });

  it('読み込んだだけで本物の console が包まれ、env.ts の先頭で読み込まれている', async () => {
    expect((console as unknown as Record<symbol, unknown>)[Symbol.for('realtime-grareco-search.safeConsole')]).toBe(true);
    const { readFileSync } = await import('node:fs');
    const env = readFileSync(new URL('../../env.ts', import.meta.url), 'utf8');
    const firstImport = env.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './logging/safeConsole.js';");
  });
});

describe('publicErrorMessage（素の pg の失敗）', () => {
  it('pool.query の失敗も固定の文にする', () => {
    const err = pgError('22P02', `invalid input syntax for type integer: "${TOKEN}"`);
    expect(isPgDatabaseError(err)).toBe(true);
    expect(publicErrorMessage(err)).toBe(DB_FAILURE_MESSAGE);
  });

  it('code を持つだけのほかの失敗（Node の ENOENT など）は今までどおり', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(isPgDatabaseError(err)).toBe(false);
    expect(publicErrorMessage(err)).toBe('no such file');
  });
});
