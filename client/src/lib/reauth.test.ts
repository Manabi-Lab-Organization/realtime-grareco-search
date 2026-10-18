import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithReauth, setReauthHandler } from './reauth';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fetchWithReauth', () => {
  afterEach(() => {
    setReauthHandler(null);
    vi.unstubAllGlobals();
  });

  it('再認証を求める 403 を受けたら確認を出し、成功したら 1 回だけ送り直す', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(403, { code: 'reauth_required', message: 'x' }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => true);
    setReauthHandler(handler);
    const res = await fetchWithReauth('/api/user/account', { method: 'DELETE' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('確認が取り消されたら送り直さずに 403 を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(403, { code: 'reauth_required' }));
    vi.stubGlobal('fetch', fetchMock);
    setReauthHandler(async () => false);
    const res = await fetchWithReauth('/api/user/account', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
  });

  it('再認証以外の理由の 403 では確認を出さない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { error: 'Forbidden' })));
    const handler = vi.fn(async () => true);
    setReauthHandler(handler);
    const res = await fetchWithReauth('/api/admin/users');
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});
