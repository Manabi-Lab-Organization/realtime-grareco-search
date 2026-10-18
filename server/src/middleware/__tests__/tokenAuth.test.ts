import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findActiveToken = vi.fn();
vi.mock('../../services/apiTokenService.js', async (orig) => {
  const actual = await orig<typeof import('../../services/apiTokenService.js')>();
  return { ...actual, findActiveToken: (t: string) => findActiveToken(t) };
});
const auditCalls: Array<{ event: string; opts: any }> = [];
vi.mock('../../services/audit/audit.js', () => ({
  audit: vi.fn(async (event: string, opts: any) => { auditCalls.push({ event, opts }); }),
  auditLater: vi.fn((event: string, opts: any) => { auditCalls.push({ event, opts }); }),
}));
vi.mock('../../db/index.js', () => ({ db: {} }));

import { requireAuth } from '../auth.js';
import { requireTokenAuth } from '../tokenAuth.js';
import { requireAdmin } from '../admin.js';
import { getAuth, authUserId } from '../authContext.js';

function mockReq(opts: { headers?: Record<string, string>; query?: Record<string, string>; session?: Record<string, unknown> } = {}) {
  const session: Record<string, unknown> = { ...(opts.session ?? {}) };
  return {
    headers: opts.headers ?? {},
    query: opts.query ?? {},
    path: '/api/meetings',
    originalUrl: '/api/meetings',
    session,
  } as any;
}
function mockRes() {
  const res: any = { locals: {}, statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
function link(req: any, res: any) { req.res = res; return { req, res }; }

const USER = { tokenId: 7, userId: 42, email: 'a@example.com', displayName: '山田', deviceName: 'ノートPC', clientType: 'desktop' };

describe('トークンによる認証', () => {
  const saved = process.env.ALLOW_LEGACY_QUERY_TOKEN;
  beforeEach(() => { findActiveToken.mockReset(); auditCalls.length = 0; delete process.env.ALLOW_LEGACY_QUERY_TOKEN; });
  afterEach(() => { if (saved === undefined) delete process.env.ALLOW_LEGACY_QUERY_TOKEN; else process.env.ALLOW_LEGACY_QUERY_TOKEN = saved; });

  it('Bearer トークンで認証し、結果を res.locals.auth に入れ、セッションは変えない', async () => {
    findActiveToken.mockResolvedValue(USER);
    const { req, res } = link(mockReq({ headers: { authorization: 'Bearer tok123' } }), mockRes());
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(findActiveToken).toHaveBeenCalledWith('tok123');
    expect(res.locals.auth).toMatchObject({ userId: 42, method: 'token', tokenId: 7 });
    expect(req.session).toEqual({});
    expect(getAuth(req)?.userId).toBe(42);
    expect(authUserId(req)).toBe(42);
  });

  it('無効なトークンには 401 を返す', async () => {
    findActiveToken.mockResolvedValue(null);
    const { req, res } = link(mockReq({ headers: { authorization: 'Bearer bad' } }), mockRes());
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'token_invalid', code: 'token_invalid' });
  });

  it('URL のトークンは既定で拒否して 426 を返し、トークンの値を含めずに記録する', async () => {
    findActiveToken.mockResolvedValue(USER);
    const { req, res } = link(mockReq({ query: { token: 'legacy-1' }, headers: { 'x-client-version': '1.2.3' } }), mockRes());
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(426);
    expect(res.body).toEqual({ code: 'update_required', message: '新しいバージョンに更新してください' });
    expect(findActiveToken).not.toHaveBeenCalled();
    const a = auditCalls.find((c) => c.event === 'token.legacy_query');
    expect(a?.opts.detail).toMatchObject({ accepted: false, clientVersion: '1.2.3' });
    expect(JSON.stringify(a)).not.toContain('legacy-1');
  });

  it('許可の設定があるときは URL のトークンを受け付けて記録する', async () => {
    process.env.ALLOW_LEGACY_QUERY_TOKEN = 'true';
    findActiveToken.mockResolvedValue(USER);
    const { req, res } = link(mockReq({ query: { token: 'legacy-2' } }), mockRes());
    const next = vi.fn();
    await requireTokenAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.auth.userId).toBe(42);
    expect(auditCalls.find((c) => c.event === 'token.legacy_query')?.opts.detail.accepted).toBe(true);
  });

  it('requireTokenAuth は Cookie のセッションだけでは通さない', async () => {
    const { req, res } = link(mockReq({ session: { userId: 1 } }), mockRes());
    const next = vi.fn();
    await requireTokenAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('requireAuth は Cookie のセッションで通し、method を session にする', async () => {
    const { req, res } = link(mockReq({ session: { userId: 5, email: 's@example.com' } }), mockRes());
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.auth).toMatchObject({ userId: 5, method: 'session' });
  });
});

describe('requireAdmin', () => {
  it('トークンで認証した要求には 403 を返す', async () => {
    const { req, res } = link(mockReq(), mockRes());
    res.locals.auth = { userId: 1, email: null, displayName: null, method: 'token', tokenId: 3 };
    const next = vi.fn();
    await requireAdmin(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('admin_requires_session');
  });
});
