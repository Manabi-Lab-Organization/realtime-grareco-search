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

// DB 以外の失敗に入る値（会議の中身・鍵・リクエストや応答の中身）
describe('JSON の解釈の失敗：解釈できなかった文字列（AI の出力＝会議の中身）を出さない', () => {
  function parseError(text: string): Error {
    try {
      JSON.parse(text);
    } catch (e) {
      return e as Error;
    }
    throw new Error('失敗するはず');
  }

  it('エラーのまま渡しても、message・stack に断片が残らない', () => {
    const err = parseError('次回の定例会議は山田さんの都合で延期 {"a":');
    expect(err.message).toContain('次回の定例会議'); // 元のエラーには入っている
    const out = printed(sanitizeLogError(err));
    expect(out).not.toContain('次回の定例会議');
    expect(out).not.toContain('山田');
    expect(out).toContain('SyntaxError');
    expect(out).toContain('is not valid JSON');
    expect(out).toMatch(/\n\s+at /); // 呼び出し元は残す
    expect(err.message).toContain('次回の定例会議'); // 元のエラーは書き換えない
  });

  it('`${err}`・err.message で文字列にして渡しても同じ', () => {
    const err = parseError('担当は"佐藤"、予算は 300 万円');
    expect(redactLogText(`読めませんでした: ${err}`)).not.toContain('佐藤');
    expect(redactLogText(`読めませんでした: ${err}`)).not.toContain('300 万円');
    expect(redactLogText(err.message)).toContain('is not valid JSON');
  });

  it('断片の無い失敗の文（Unexpected end of JSON input）はそのまま', () => {
    const err = parseError('{"a":');
    expect(sanitizeLogError(err)).toBe(err);
  });
});

describe('鍵・トークンを出さない', () => {
  it('Bearer・決まった書き出しの鍵・接続文字列のパスワード・URL の鍵の値を伏せる', () => {
    const text =
      'fetch https://generativelanguage.googleapis.com/v1/models?key=AIzaSyA-0123456789abcdefghijklmn&alt=json failed ' +
      'with Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature, postgres://app:s3cretPass@db.internal:5432/main, ' +
      'sk-ant-api03-abcdefghijklmnopqrstu, sk_live_0123456789abcdefghij, https://example.com/cb?code=oauthcode123&state=ok';
    const out = redactLogText(text);
    for (const secret of ['AIzaSyA', 'eyJhbGci', 's3cretPass', 'sk-ant-api03', 'sk_live_0123', 'oauthcode123']) expect(out).not.toContain(secret);
    // 追うのに要るものは残す（どこへの通信か・鍵でない値）
    expect(out).toContain('https://generativelanguage.googleapis.com/v1/models?key=…&alt=json');
    expect(out).toContain('postgres://…@db.internal:5432/main');
    expect(out).toContain('state=ok');
  });

  it('ふつうの文は変えない（URL・「Basic プラン」・task- で始まる ID・短い値）', () => {
    for (const text of [
      'GET https://api.example.com/v1/meetings/123 → 200',
      'Basic プランに変更しました。Basic information を表示',
      'task-0123456789abcdefghijk を開始',
      '[Credit] userId=7 amount=3 type=grareco',
    ]) {
      expect(redactLogText(text)).toBe(text);
    }
  });
});

describe('エラーに付いたリクエスト・応答の中身を出さない', () => {
  it('config（Authorization ヘッダ）・response（本文）を外し、状態と code は残す', () => {
    const err = Object.assign(new Error('Request failed with status code 429'), {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      config: { headers: { Authorization: 'Bearer live-token-abcdefgh' }, data: '{"prompt":"会議の文字起こし"}' },
      response: { status: 429, data: { echoed: '会議の文字起こし' }, headers: { 'set-cookie': 'sid=abc' } },
    });
    const safe = sanitizeLogError(err);
    const out = printed(safe);
    expect(out).not.toContain('live-token');
    expect(out).not.toContain('文字起こし');
    expect(out).not.toContain('set-cookie');
    expect(out).toContain('Request failed with status code 429');
    expect(out).toContain('ERR_BAD_REQUEST');
    expect((safe as unknown as { status: number }).status).toBe(429);
    // 元のエラーは呼び出し元がまだ使うので、そのまま
    expect((err as unknown as { response: { status: number } }).response.status).toBe(429);
    expect((err as unknown as { config: unknown }).config).toBeDefined();
  });

  it('SDK のエラー（headers・error・raw を持つ）も、状態と文だけにする', () => {
    const err = Object.assign(new Error('400 invalid_request_error'), {
      status: 400,
      headers: { 'request-id': 'req_1' },
      error: { type: 'error', error: { message: '入力の一部がここに出る' } },
      raw: { customer_email: 'taro@example.com' },
    });
    const out = printed(sanitizeLogError(err));
    expect(out).not.toContain('入力の一部');
    expect(out).not.toContain('taro@');
    expect(out).toContain('status: 400');
  });
});

describe('エラーの文の中のメールアドレス', () => {
  it('message・stack では t***@example.com の形にする', () => {
    const out = printed(sanitizeLogError(new Error(`送信に失敗: ${EMAIL} は受け取れません`)));
    expect(out).not.toContain(EMAIL);
    expect(out).toContain('t***@example.com');
  });

  it('ふつうのログの文字列は変えない（監査ログなど、出す側で形を決めているもの）', () => {
    expect(sanitizeLogArg(`[Auth] login ${EMAIL}`)).toBe(`[Auth] login ${EMAIL}`);
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
