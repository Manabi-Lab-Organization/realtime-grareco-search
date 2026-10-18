import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { maskEmail, getClientIp, normalizeIp, redactPath, sanitizeDetail, tokenLast4 } from '../logSafety.js';
import { buildAuditRecord, audit, auditAuthFailure, __setAuditWriterForTest, type AuditRecord } from '../audit.js';
import { runWithAuditContext } from '../requestContext.js';
import { buildAccessLogLine } from '../accessLog.js';
import { objectKeyForDay, auditEnvName, candidateDays, toJsonLines, r2ConfigFromEnv, retentionDaysFromEnv } from '../auditExport.js';
import { rateLimitHitHandler } from '../../../middleware/rateLimit.js';

function fakeReq(over: Partial<Record<string, unknown>> = {}): Request {
  return {
    headers: { 'user-agent': 'UA/1.0', ...(over.headers as object) },
    socket: { remoteAddress: '10.0.0.9' },
    app: { get: (k: string) => (k === 'trust proxy' ? over.trustProxy ?? 1 : undefined) },
    session: over.session,
    requestId: over.requestId ?? 'req-123',
    method: 'POST',
    baseUrl: '/api/auth',
    path: '/login',
    originalUrl: over.originalUrl ?? '/api/auth/login',
    body: over.body,
  } as unknown as Request;
}

afterEach(() => {
  __setAuditWriterForTest(null);
  vi.restoreAllMocks();
});

describe('maskEmail', () => {
  it('@ より前は先頭の 1 文字だけを残す', () => {
    expect(maskEmail('yamada@example.co.jp')).toBe('y***@example.co.jp');
  });
  it('メールアドレスでない値は決まった文字列にする', () => {
    expect(maskEmail(undefined)).toBe('[no-email]');
    expect(maskEmail('abc')).toBe('[no-email]');
  });
});

describe('接続元の IP アドレス', () => {
  it('プロキシを信頼する設定では X-Forwarded-For の最後の値を使う', () => {
    const req = fakeReq({ headers: { 'x-forwarded-for': '192.0.2.66, 203.0.113.7' } });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });
  it('プロキシを信頼しない設定ではソケットの値を使う', () => {
    const req = fakeReq({ trustProxy: false, headers: { 'x-forwarded-for': '192.0.2.66' } });
    expect(getClientIp(req)).toBe('10.0.0.9');
  });
  it('IPv4 を含む IPv6 表記を IPv4 に戻し、IP でない値には null を返す', () => {
    expect(normalizeIp('::ffff:198.51.100.1')).toBe('198.51.100.1');
    expect(normalizeIp('not-an-ip')).toBeNull();
  });

  it('プロキシを 1 段信頼する設定では req.ip と同じ値になる', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ reqIp: req.ip, ours: getClientIp(req) }));
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'X-Forwarded-For': '192.0.2.66, 203.0.113.7' } });
      const body = (await r.json()) as { reqIp: string; ours: string };
      expect(body.reqIp).toBe('203.0.113.7');
      expect(body.ours).toBe('203.0.113.7');
    } finally {
      server.close();
    }
  });
});

describe('ログに残す値の伏せ方', () => {
  it('共有リンクのトークンをパスの中で伏せる', () => {
    expect(redactPath('/api/share/abcDEF123/meta')).toBe('/api/share/[token]/meta');
    expect(redactPath('/share/abcDEF123')).toBe('/share/[token]');
    expect(redactPath('/api/meetings/12')).toBe('/api/meetings/12');
  });
  it('秘密の値らしいキーを伏せ、長い文を切り詰める', () => {
    const out = sanitizeDetail({ password: 'x', token: 'y', apiKey: 'z', tokenLast4: 'abcd', note: 'a'.repeat(1000), nested: { refreshToken: 'r' } }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.tokenLast4).toBe('abcd');
    expect(String(out.note).length).toBeLessThan(120);
    expect((out.nested as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
  });
  it('トークンの末尾 4 文字を返し、短すぎるときは null を返す', () => {
    expect(tokenLast4('0123456789abcdef')).toBe('cdef');
    expect(tokenLast4('short')).toBeNull();
  });
});

describe('buildAuditRecord', () => {
  it('要求から利用者・IP・ユーザーエージェント・要求 ID を読み取る', () => {
    const req = fakeReq({ session: { userId: 7, email: 'a@example.jp' }, headers: { 'x-forwarded-for': '203.0.113.7' } });
    const rec = buildAuditRecord('meeting.delete', { target: { type: 'meeting', id: 99 } }, req);
    expect(rec).toMatchObject({
      app: 'realtime-grareco-search', event: 'meeting.delete', result: 'success',
      actorId: '7', actorEmail: 'a@example.jp', actorRole: 'user',
      targetType: 'meeting', targetId: '99', ip: '203.0.113.7', userAgent: 'UA/1.0', requestId: 'req-123',
    });
  });
  it('要求が無いときは実行中の文脈から利用者を読み取る', () => {
    const rec = runWithAuditContext({ channel: 'socketio', actorId: 42 }, () => buildAuditRecord('llm.call', {}));
    expect(rec.actorId).toBe('42');
    expect(rec.ip).toBeNull();
  });
  it('文脈も要求も無ければ system とする', () => {
    const rec = buildAuditRecord('account.delete', {});
    expect(rec.actorRole).toBe('system');
    expect(rec.actorId).toBeNull();
  });
});

describe('audit()', () => {
  it('既定では書き込みに失敗しても例外を投げない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    __setAuditWriterForTest(async () => { throw new Error('db down'); });
    await expect(audit('logout', {}, fakeReq())).resolves.toBeUndefined();
  });
  it('strict を指定すると書き込みの失敗で例外を投げる', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    __setAuditWriterForTest(async () => { throw new Error('db down'); });
    await expect(audit('admin.role_change', { strict: true }, fakeReq())).rejects.toThrow('db down');
  });
  it('標準出力にはメールアドレスを出さない', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    __setAuditWriterForTest(async () => {});
    await audit('login.success', { actor: { id: 1, email: 'secret@example.com' } }, fakeReq());
    expect(logs.join('\n')).not.toContain('secret@example.com');
    expect(logs.join('\n')).toContain('login.success');
  });
});

describe('auditAuthFailure', () => {
  it('入力されたメールアドレスを小文字で記録し、パスワードは記録しない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const written: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { written.push(r); });
    const err = Object.assign(new Error('x'), { name: 'UnauthorizedError', statusCode: 401, publicMessage: 'bad' });
    auditAuthFailure('login.failure', 'password', err, fakeReq({ body: { email: 'Foo@Example.com', password: 'sample-pass-123' } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ event: 'login.failure', result: 'failure', actorEmail: 'foo@example.com', authMethod: 'password' });
    expect(JSON.stringify(written[0])).not.toContain('sample-pass-123');
  });
  it('入力の形式の誤りは記録しない', async () => {
    const written: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { written.push(r); });
    auditAuthFailure('login.failure', 'password', Object.assign(new Error('x'), { name: 'ZodError' }), fakeReq());
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(0);
  });
});

describe('rate_limit.hit', () => {
  it('回数の上限に達したことを記録し、同じ接続元は 1 分に 1 件にまとめる', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const written: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { written.push(r); });
    const handler = rateLimitHitHandler('test');
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as Response;
    const req = fakeReq({ headers: { 'x-forwarded-for': '198.51.100.44' } });
    const options = { statusCode: 429, message: { error: 'too many' } } as never;
    handler(req, res, () => {}, options);
    handler(req, res, () => {}, options);
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ event: 'rate_limit.hit', result: 'denied', ip: '198.51.100.44' });
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe('buildAccessLogLine', () => {
  it('クエリ文字列を除き、共有リンクのトークンを伏せる', () => {
    const req = fakeReq({ originalUrl: '/api/share/tok123/meta?x=1', session: { userId: 3 } });
    (req as unknown as { method: string }).method = 'GET';
    const res = { statusCode: 200 } as Response;
    const line = buildAccessLogLine(req, res, 0n, 5_000_000n);
    expect(line).toMatchObject({ type: 'access', method: 'GET', path: '/api/share/[token]/meta', status: 200, durationMs: 5, userId: 3, requestId: 'req-123' });
    expect(JSON.stringify(line)).not.toContain('x=1');
  });
});

describe('記録のファイルへの書き出し', () => {
  it('保存先のキーをアプリ名・環境名・日付から組み立てる', () => {
    expect(objectKeyForDay('2001-04-15', 'realtime-grareco-search', 'production')).toBe('audit/realtime-grareco-search/production/2001/04/15.jsonl.gz');
  });
  it('環境名が違えば同じ日でも別のキーになる', () => {
    const prod = objectKeyForDay('2001-04-15', 'realtime-grareco-search', auditEnvName({ AUDIT_R2_ENV: 'production' }));
    const dev = objectKeyForDay('2001-04-15', 'realtime-grareco-search', auditEnvName({ AUDIT_R2_ENV: 'staging' }));
    expect(prod).not.toBe(dev);
  });
  it('環境名を環境変数から読み、使えない文字をハイフンに置き換える', () => {
    expect(auditEnvName({ AUDIT_R2_ENV: 'Production' })).toBe('production');
    expect(auditEnvName({ AUDIT_R2_ENV: 'team a/test' })).toBe('team-a-test');
    expect(auditEnvName({})).toBe('local');
  });
  it('最も古い記録の日から前日までの日付を返す', () => {
    const now = new Date('2001-04-15T01:00:00Z');
    expect(candidateDays(now, new Date('2001-04-13T23:59:00Z'))).toEqual(['2001-04-13', '2001-04-14']);
    expect(candidateDays(now, null)).toEqual(['2001-04-14']);
  });
  it('さかのぼる日数に上限を設けない', () => {
    const days = candidateDays(new Date('2001-04-15T00:00:00Z'), new Date('2000-04-15T00:00:00Z'));
    expect(days[0]).toBe('2000-04-15');
    expect(days[days.length - 1]).toBe('2001-04-14');
    expect(days).toHaveLength(365);
  });
  it('1 行に 1 件ずつ書き、日時は ISO 8601 の文字列にする', () => {
    const out = toJsonLines([{ id: 1, ts: new Date('2001-04-14T00:00:00Z'), event: 'logout' }, { id: 2, ts: new Date('2001-04-14T00:00:01Z'), event: 'signup' }]);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, ts: '2001-04-14T00:00:00.000Z', event: 'logout' });
  });
  it('必要な環境変数が 1 つでも無ければ null を返す', () => {
    expect(r2ConfigFromEnv({ AUDIT_R2_ACCOUNT_ID: 'a', AUDIT_R2_ACCESS_KEY_ID: 'b', AUDIT_R2_SECRET_ACCESS_KEY: 'c' })).toBeNull();
    expect(r2ConfigFromEnv({ AUDIT_R2_ACCOUNT_ID: 'a', AUDIT_R2_ACCESS_KEY_ID: 'b', AUDIT_R2_SECRET_ACCESS_KEY: 'c', AUDIT_R2_BUCKET: 'd' })).toMatchObject({ bucket: 'd' });
  });
  it('保持日数の既定は 400 日で、1 年より短い値は使わない', () => {
    expect(retentionDaysFromEnv({})).toBe(400);
    expect(retentionDaysFromEnv({ AUDIT_DB_RETENTION_DAYS: '30' })).toBe(400);
    expect(retentionDaysFromEnv({ AUDIT_DB_RETENTION_DAYS: '1095' })).toBe(1095);
  });
});
